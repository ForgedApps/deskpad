//! Win32 AppBar registration so the sidebar reserves screen space on the right edge
//! (maximized windows stop at its left border, like the taskbar).

#[cfg(windows)]
pub mod imp {
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::UI::Shell::{
        DefSubclassProc, SHAppBarMessage, SetWindowSubclass, ABE_RIGHT, ABM_NEW, ABM_QUERYPOS,
        ABM_REMOVE, ABM_SETPOS, ABN_POSCHANGED, APPBARDATA,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsWindowVisible, KillTimer, SetTimer, SetWindowPos, ShowWindow,
        SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, WM_APP, WM_DISPLAYCHANGE,
        WM_DPICHANGED, WM_POWERBROADCAST, WM_SETTINGCHANGE, WM_TIMER,
    };

    /// Message the shell sends us for AppBar notifications (ABN_*).
    const CALLBACK_MSG: u32 = WM_APP + 0x0A5B;
    const SUBCLASS_ID: usize = 0x0A5B;
    /// `WM_POWERBROADCAST` events for waking up (PBT_APMRESUMEAUTOMATIC / ..SUSPEND).
    const PBT_APMRESUMESUSPEND: usize = 0x0007;
    const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
    /// Timer that re-checks the dock once a second for a while after anything that
    /// can move us (display or work-area change, AppBar notification, wake from sleep).
    /// A single check is not enough: on resume the display comes back in steps and
    /// the shell may move us after we already answered the first notification.
    const SWEEP_TIMER: usize = 0x0A5C;
    const SWEEP_TICKS: u32 = 12;
    /// Slow background check as a last resort for events nobody notifies us about.
    const SLOW_TIMER: usize = 0x0A5D;
    const SLOW_MS: u32 = 20_000;

    /// Width of the current reservation in physical pixels (0 = not reserving).
    static RESERVED_WIDTH: AtomicI32 = AtomicI32::new(0);
    /// When we last docked, in ms since the epoch. Notifications arriving right after
    /// our own ABM_NEW/ABM_SETPOS are echoes of that and are ignored.
    static LAST_DOCK_MS: AtomicU64 = AtomicU64::new(0);
    /// Sweep ticks left (0 = sweep timer idle).
    static SWEEP_LEFT: AtomicU32 = AtomicU32::new(0);
    /// Set when a re-dock did not get us flush with the edge (something else owns
    /// it, e.g. a right-hand taskbar); the slow timer then leaves things alone
    /// until the next notification, instead of re-registering every tick.
    static STUCK: AtomicBool = AtomicBool::new(false);

    fn now_ms() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }

    /// True when the window is visible, reserving space, and not flush with the right
    /// edge of its monitor at the reserved width. That is what a stale reservation from
    /// a previous process looks like: the installer kills the old Deskpad and relaunches
    /// at once, the shell still holds the dead window's strip, and ABM_QUERYPOS places
    /// the new window inboard of it. Once the shell drops that strip we must re-dock.
    pub unsafe fn needs_redock(hwnd: HWND) -> bool {
        unsafe {
            let width = RESERVED_WIDTH.load(Ordering::Relaxed);
            if width == 0 || !IsWindowVisible(hwnd).as_bool() {
                return false;
            }
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_err() {
                return false;
            }
            let (full, _) = monitor_rects(hwnd);
            r.right != full.right || r.right - r.left != width
        }
    }

    /// Re-dock if `needs_redock`, unless we docked ourselves within the last 500 ms.
    pub unsafe fn redock_if_displaced(hwnd: HWND) -> bool {
        unsafe {
            if now_ms().saturating_sub(LAST_DOCK_MS.load(Ordering::Relaxed)) <= 500
                || !needs_redock(hwnd)
            {
                return false;
            }
            let width = RESERVED_WIDTH.load(Ordering::Relaxed);
            dock_right(hwnd, width, true);
            STUCK.store(needs_redock(hwnd), Ordering::Relaxed);
            true
        }
    }

    /// Start (or restart) the one-second sweep that re-checks the dock for a while.
    unsafe fn start_sweep(hwnd: HWND) {
        unsafe {
            STUCK.store(false, Ordering::Relaxed);
            SWEEP_LEFT.store(SWEEP_TICKS, Ordering::Relaxed);
            SetTimer(Some(hwnd), SWEEP_TIMER, 1000, None);
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        unsafe {
            let notified = (msg == CALLBACK_MSG && wparam.0 as u32 == ABN_POSCHANGED)
                || msg == WM_DISPLAYCHANGE
                || msg == WM_SETTINGCHANGE
                || msg == WM_DPICHANGED
                || (msg == WM_POWERBROADCAST
                    && (wparam.0 == PBT_APMRESUMEAUTOMATIC || wparam.0 == PBT_APMRESUMESUSPEND));
            if notified {
                redock_if_displaced(hwnd);
                start_sweep(hwnd);
            }
            if msg == WM_TIMER && wparam.0 == SWEEP_TIMER {
                let left = SWEEP_LEFT.load(Ordering::Relaxed).saturating_sub(1);
                SWEEP_LEFT.store(left, Ordering::Relaxed);
                if left == 0 {
                    let _ = KillTimer(Some(hwnd), SWEEP_TIMER);
                }
                if redock_if_displaced(hwnd) {
                    eprintln!("[dock] re-docked after displacement (sweep)");
                }
                return LRESULT(0);
            }
            if msg == WM_TIMER && wparam.0 == SLOW_TIMER {
                if !STUCK.load(Ordering::Relaxed) && redock_if_displaced(hwnd) {
                    eprintln!("[dock] re-docked after displacement (slow check)");
                }
                return LRESULT(0);
            }
            if msg == CALLBACK_MSG {
                return LRESULT(0);
            }
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
    }

    fn data(hwnd: HWND) -> APPBARDATA {
        APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: hwnd,
            uCallbackMessage: CALLBACK_MSG,
            uEdge: ABE_RIGHT,
            rc: RECT::default(),
            lParam: LPARAM(0),
        }
    }

    /// Physical rect of the monitor the window is on: (full, work).
    pub unsafe fn monitor_rects(hwnd: HWND) -> (RECT, RECT) {
        unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
            let mut mi = MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                ..Default::default()
            };
            let _ = GetMonitorInfoW(monitor, &mut mi);
            (mi.rcMonitor, mi.rcWork)
        }
    }

    /// Dock the window to the right edge. When `reserve` is true the space is reserved
    /// via the shell AppBar API. Safe to call repeatedly: any previous registration for
    /// this window is dropped first so the new position is computed against a clean
    /// work area (otherwise the shell would push us left of our own old reservation).
    /// Returns the final physical rect (x, y, w, h).
    pub unsafe fn dock_right(hwnd: HWND, width_px: i32, reserve: bool) -> (i32, i32, i32, i32) {
        unsafe {
            let mut abd = data(hwnd);
            SHAppBarMessage(ABM_REMOVE, &mut abd);
            // Idempotent for the same id; lets us hear ABN_POSCHANGED and re-dock.
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
            if reserve {
                SetTimer(Some(hwnd), SLOW_TIMER, SLOW_MS, None);
            } else {
                let _ = KillTimer(Some(hwnd), SLOW_TIMER);
            }
            RESERVED_WIDTH.store(if reserve { width_px } else { 0 }, Ordering::Relaxed);
            LAST_DOCK_MS.store(now_ms(), Ordering::Relaxed);

            let (full, work) = monitor_rects(hwnd);
            if reserve {
                SHAppBarMessage(ABM_NEW, &mut abd);
                abd.rc = RECT {
                    left: full.right - width_px,
                    top: full.top,
                    right: full.right,
                    bottom: full.bottom,
                };
                SHAppBarMessage(ABM_QUERYPOS, &mut abd);
                abd.rc.left = abd.rc.right - width_px;
                SHAppBarMessage(ABM_SETPOS, &mut abd);
            } else {
                abd.rc = RECT {
                    left: work.right - width_px,
                    top: work.top,
                    right: work.right,
                    bottom: work.bottom,
                };
            }
            let r = abd.rc;
            let _ = SetWindowPos(
                hwnd,
                None,
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER,
            );
            (r.left, r.top, r.right - r.left, r.bottom - r.top)
        }
    }

    pub unsafe fn undock(hwnd: HWND) {
        unsafe {
            let mut abd = data(hwnd);
            SHAppBarMessage(ABM_REMOVE, &mut abd);
            RESERVED_WIDTH.store(0, Ordering::Relaxed);
            let _ = KillTimer(Some(hwnd), SLOW_TIMER);
            let _ = KillTimer(Some(hwnd), SWEEP_TIMER);
        }
    }

    /// Hide natively. We deliberately bypass tao's `set_visible(false)` here: its
    /// matching show path re-applies window styles and calls ShowWindow, which makes
    /// Windows nudge a window that sits entirely outside the work area (i.e. an
    /// appbar) back inside it. `dock_right` shows the window again via SetWindowPos.
    pub unsafe fn hide(hwnd: HWND) {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}
