// Today's weather under the clock. The place is a city typed in Settings; it
// is looked up once (Open-Meteo's geocoder) and the forecast comes from
// Open-Meteo, or from MET Norway when Open-Meteo doesn't answer. Neither needs
// a key. Nothing is requested while the city is empty, and the only thing
// sent is that city name and its coordinates. Results are cached in
// localStorage so a restart doesn't refetch and an outage shows the last
// known weather.

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export type WeatherUnit = "f" | "c";

interface Place {
  query: string;
  name: string;
  lat: number;
  lon: number;
}

interface Weather {
  at: number;
  key: string;
  place: string;
  temp: number;
  high: number;
  low: number;
  rain: number | null;
  kind: Kind;
  day: boolean;
}

type Kind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

const PLACE_KEY = "deskpad.weather.place";
const DATA_KEY = "deskpad.weather.data";
const FRESH_MS = 30 * 60_000;
const REFRESH_MS = 15 * 60_000;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a cache only */
  }
}

async function getJson<T>(url: string): Promise<T> {
  // A provider that accepts the connection and then says nothing must not hang the line.
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`weather service answered ${res.status}`);
  return (await res.json()) as T;
}

async function findPlace(query: string): Promise<Place | null> {
  const cached = read<Place>(PLACE_KEY);
  if (cached && cached.query === query) return cached;
  // "Bend, OR" style input: the geocoder wants the name alone, and the rest narrows the match.
  const [name, ...rest] = query.split(",").map((s) => s.trim()).filter(Boolean);
  const hint = rest.join(" ").toLowerCase();
  const data = await getJson<{ results?: { name: string; latitude: number; longitude: number; admin1?: string; country?: string; country_code?: string }[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`,
  );
  const results = data.results ?? [];
  if (!results.length) return null;
  const pick =
    (hint &&
      results.find((r) =>
        [r.admin1, r.country, r.country_code].some((v) => {
          const s = (v ?? "").toLowerCase();
          return s && (s === hint || s.startsWith(hint) || hint.includes(s) || initials(s) === hint);
        }),
      )) ||
    results[0];
  const place: Place = { query, name: [pick.name, pick.admin1].filter(Boolean).join(", "), lat: pick.latitude, lon: pick.longitude };
  write(PLACE_KEY, place);
  return place;
}

/** "new york" -> "ny", so a state can be typed as its abbreviation. */
const initials = (s: string) => (s.includes(" ") ? s.split(/\s+/).map((w) => w[0]).join("") : s.slice(0, 2));

const toUnit = (celsius: number, unit: WeatherUnit) => Math.round(unit === "c" ? celsius : (celsius * 9) / 5 + 32);

/** Open-Meteo: current conditions plus the day's high, low and chance of rain. */
async function fromOpenMeteo(place: Place, unit: WeatherUnit): Promise<Omit<Weather, "at" | "key" | "place">> {
  const data = await getJson<{
    current: { temperature_2m: number; weather_code: number; is_day: number };
    daily: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
  }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      `&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=${unit === "c" ? "celsius" : "fahrenheit"}&timezone=auto&forecast_days=1`,
  );
  return {
    temp: Math.round(data.current.temperature_2m),
    high: Math.round(data.daily.temperature_2m_max[0]),
    low: Math.round(data.daily.temperature_2m_min[0]),
    rain: data.daily.precipitation_probability_max[0] ?? null,
    kind: kindOfWmo(data.current.weather_code),
    day: data.current.is_day === 1,
  };
}

/** MET Norway: an hourly series in Celsius; the day's range is read off the hours left today. */
async function fromMetNo(place: Place, unit: WeatherUnit): Promise<Omit<Weather, "at" | "key" | "place">> {
  interface Step {
    time: string;
    data: { instant: { details: { air_temperature: number } }; next_1_hours?: { summary: { symbol_code: string } }; next_6_hours?: { summary: { symbol_code: string } } };
  }
  const data = await getJson<{ properties: { timeseries: Step[] } }>(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${place.lat.toFixed(4)}&lon=${place.lon.toFixed(4)}`,
  );
  const series = data.properties.timeseries;
  if (!series.length) throw new Error("empty forecast");
  const now = series[0];
  const today = new Date().toDateString();
  let hours = series.filter((t) => new Date(t.time).toDateString() === today);
  // Late in the evening "the rest of today" is an hour or two; look half a day ahead instead.
  if (hours.length < 4) hours = series.slice(0, 12);
  const temps = hours.map((t) => t.data.instant.details.air_temperature);
  const symbol = now.data.next_1_hours?.summary.symbol_code ?? now.data.next_6_hours?.summary.symbol_code ?? "cloudy";
  return {
    temp: toUnit(now.data.instant.details.air_temperature, unit),
    high: toUnit(Math.max(...temps), unit),
    low: toUnit(Math.min(...temps), unit),
    rain: null,
    kind: kindOfSymbol(symbol),
    day: !symbol.endsWith("_night"),
  };
}

async function fetchWeather(city: string, unit: WeatherUnit): Promise<Weather | null> {
  const place = await findPlace(city);
  if (!place) return null;
  let body: Omit<Weather, "at" | "key" | "place">;
  try {
    body = await fromOpenMeteo(place, unit);
  } catch (err) {
    console.warn("weather: Open-Meteo unavailable, trying MET Norway", err);
    body = await fromMetNo(place, unit);
  }
  return { at: Date.now(), key: `${city}|${unit}`, place: place.name, ...body };
}

/** WMO weather codes (Open-Meteo), grouped into what we have a picture and a word for. */
function kindOfWmo(code: number): Kind {
  if (code === 0) return "clear";
  if (code === 1 || code === 2) return "partly";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloudy";
}

/** MET Norway symbol codes such as `lightrainshowers_day` or `partlycloudy_night`. */
function kindOfSymbol(symbol: string): Kind {
  const s = symbol.replace(/_(day|night|polartwilight)$/, "");
  if (s.includes("thunder")) return "storm";
  if (s.includes("snow") || s.includes("sleet")) return "snow";
  if (s.includes("lightrain")) return "drizzle";
  if (s.includes("rain")) return "rain";
  if (s === "fog") return "fog";
  if (s === "clearsky") return "clear";
  if (s === "fair" || s === "partlycloudy") return "partly";
  return "cloudy";
}

function describe(kind: Kind, day: boolean): { icon: string; text: string } {
  const sun = `<circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />`;
  const moon = `<path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />`;
  const cloud = `<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z" />`;
  // The same cloud, raised to leave room for rain or snow under it.
  const top = `<path d="M7 15h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 15z" />`;
  const drops = `<path d="M9 20l1-2M13 20l1-2M17 20l1-2" />`;
  const flakes = `<path d="M9 20h.01M13 20h.01M17 20h.01" />`;
  switch (kind) {
    case "clear":
      return { icon: day ? sun : moon, text: "Clear" };
    case "partly":
      return { icon: cloud, text: "Partly cloudy" };
    case "fog":
      return { icon: `<path d="M4 9h16M4 13h16M6 17h12" />`, text: "Fog" };
    case "drizzle":
      return { icon: top + drops, text: "Light rain" };
    case "rain":
      return { icon: top + drops, text: "Rain" };
    case "snow":
      return { icon: top + flakes, text: "Snow" };
    case "storm":
      return { icon: top + `<path d="M13 15l-2 3h3l-2 3" />`, text: "Thunderstorm" };
    default:
      return { icon: cloud, text: "Cloudy" };
  }
}

function render(w: Weather | null, note = "") {
  const el = $("#clock-weather");
  if (!el) return;
  if (!w) {
    el.hidden = !note;
    el.textContent = note;
    el.removeAttribute("title");
    return;
  }
  const d = describe(w.kind, w.day);
  // A droplet and the day's chance of rain; MET Norway has none, so nothing is shown then.
  const rain =
    w.rain !== null
      ? `<span class="w-rain"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5c3 3.6 5.5 6.6 5.5 10a5.5 5.5 0 0 1-11 0c0-3.4 2.5-6.4 5.5-10z" /></svg>${Math.round(w.rain)}%</span>`
      : "";
  el.hidden = false;
  // The icon sits right against its word, so it reads as "cloudy", not as a label for the line.
  el.innerHTML = `<b>${w.temp}°</b><span class="w-kind"><svg viewBox="0 0 24 24" aria-hidden="true">${d.icon}</svg>${d.text}</span><span class="w-range">${w.high}° / ${w.low}°</span>${rain}`;
  el.title = `${w.place}: ${d.text}, ${w.temp}°. High ${w.high}°, low ${w.low}°${w.rain !== null ? `, ${w.rain}% chance of rain` : ""}.`;
}

let timer = 0;
let current = "";

/** Show the weather for `city` (empty turns it off) and keep it fresh. Call again when the settings change. */
export function setWeather(city: string, unit: WeatherUnit) {
  city = city.trim();
  const key = `${city}|${unit}`;
  if (key === current) return;
  current = key;
  window.clearInterval(timer);
  if (!city) return render(null);

  const load = async (force: boolean) => {
    const cached = read<Weather>(DATA_KEY);
    const usable = cached && cached.key === key && cached.kind ? cached : null;
    if (usable) render(usable);
    if (usable && !force && Date.now() - usable.at < FRESH_MS) return;
    try {
      const w = await fetchWeather(city, unit);
      if (current !== key) return;
      if (!w) return render(null, `No place called "${city}" was found.`);
      write(DATA_KEY, w);
      render(w);
    } catch (err) {
      // Offline or the service is down: keep showing what we had, however old.
      console.warn("weather unavailable", err);
      if (!usable && current === key) render(null);
    }
  };
  void load(false);
  timer = window.setInterval(() => void load(true), REFRESH_MS);
}
