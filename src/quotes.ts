// A quote a day at the bottom of the sidebar. The list is bundled, so nothing
// is fetched; the day picks the quote, so it is the same all day and on every
// device, and changes at local midnight. Only lines with a traceable source
// are here: popular misattributions (most "Einstein" quotes) are left out.

const QUOTES: [text: string, author: string][] = [
  ["Waste no more time arguing what a good man should be. Be one.", "Marcus Aurelius"],
  ["We suffer more often in imagination than in reality.", "Seneca"],
  ["Imagination is more important than knowledge.", "Albert Einstein"],
  ["It is not enough to be busy; so are the ants. The question is: what are we busy about?", "Henry David Thoreau"],
  ["No great thing is created suddenly.", "Epictetus"],
  ["The unexamined life is not worth living.", "Socrates"],
  ["The impediment to action advances action. What stands in the way becomes the way.", "Marcus Aurelius"],
  ["There is nothing so useless as doing with great efficiency that which should not be done at all.", "Peter Drucker"],
  ["While we are postponing, life speeds by.", "Seneca"],
  ["Life is like riding a bicycle. To keep your balance you must keep moving.", "Albert Einstein"],
  ["A journey of a thousand miles begins with a single step.", "Lao Tzu"],
  ["First say to yourself what you would be; and then do what you have to do.", "Epictetus"],
  ["He who has a why to live can bear almost any how.", "Friedrich Nietzsche"],
  ["If it is not right, do not do it; if it is not true, do not say it.", "Marcus Aurelius"],
  ["Well done is better than well said.", "Benjamin Franklin"],
  ["It is not that we have a short time to live, but that we waste a lot of it.", "Seneca"],
  ["I have no special talents. I am only passionately curious.", "Albert Einstein"],
  ["We are what we repeatedly do. Excellence, then, is not an act, but a habit.", "Will Durant, on Aristotle"],
  ["Men are disturbed not by things, but by the views which they take of them.", "Epictetus"],
  ["Life can only be understood backwards; but it must be lived forwards.", "Søren Kierkegaard"],
  ["Confine yourself to the present.", "Marcus Aurelius"],
  ["Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.", "Antoine de Saint-Exupéry"],
  ["If a man knows not to which port he sails, no wind is favorable.", "Seneca"],
  ["The important thing is not to stop questioning. Curiosity has its own reason for existing.", "Albert Einstein"],
  ["Knowing is not enough; we must apply. Willing is not enough; we must do.", "Johann Wolfgang von Goethe"],
  ["Make the best use of what is in your power, and take the rest as it happens.", "Epictetus"],
  ["The best is the enemy of the good.", "Voltaire"],
  ["Do every act of your life as though it were the very last.", "Marcus Aurelius"],
  ["How we spend our days is, of course, how we spend our lives.", "Annie Dillard"],
  ["He who is everywhere is nowhere.", "Seneca"],
  ["Try not to become a man of success, but rather try to become a man of value.", "Albert Einstein"],
  ["Nothing great was ever achieved without enthusiasm.", "Ralph Waldo Emerson"],
  ["If you wish to improve, be content to be thought foolish and stupid.", "Epictetus"],
  ["All things excellent are as difficult as they are rare.", "Baruch Spinoza"],
  ["The soul becomes dyed with the colour of its thoughts.", "Marcus Aurelius"],
  ["Great works are performed not by strength but by perseverance.", "Samuel Johnson"],
  ["Begin at once to live, and count each separate day as a separate life.", "Seneca"],
  ["The most beautiful thing we can experience is the mysterious.", "Albert Einstein"],
  ["To see what is right and not do it is want of courage.", "Confucius"],
  ["How long are you going to wait before you demand the best for yourself?", "Epictetus"],
  ["The art of being wise is the art of knowing what to overlook.", "William James"],
  ["The best revenge is not to be like your enemy.", "Marcus Aurelius"],
  ["Our life is frittered away by detail. Simplify, simplify.", "Henry David Thoreau"],
  ["No man was ever wise by chance.", "Seneca"],
  ["Only a life lived for others is a life worthwhile.", "Albert Einstein"],
  ["He who has begun has half done. Dare to be wise; begin.", "Horace"],
  ["Loss is nothing else but change, and change is Nature's delight.", "Marcus Aurelius"],
  ["Lost time is never found again.", "Benjamin Franklin"],
  ["It is not the man who has too little, but the man who craves more, that is poor.", "Seneca"],
  ["Do not spoil what you have by desiring what you have not.", "Epicurus"],
  ["Act as if what you do makes a difference. It does.", "William James"],
  ["Look well into thyself; there is a source of strength which will always spring up if thou wilt always look.", "Marcus Aurelius"],
  ["Life is long, if you know how to use it.", "Seneca"],
  ["Character is destiny.", "Heraclitus"],
];

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The quote for a local day. Steps through the list by a stride coprime to its length, so every quote comes up once per cycle. */
export function quoteFor(date: Date): { text: string; author: string } {
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
  const n = QUOTES.length;
  let stride = 17;
  while (gcd(stride, n) !== 1) stride++;
  const [text, author] = QUOTES[(day * stride) % n];
  return { text, author };
}

/** Put today's quote into `#quote`. Safe to call often. */
export function showQuote(now = new Date()) {
  const el = document.querySelector<HTMLElement>("#quote");
  if (!el) return;
  const q = quoteFor(now);
  el.replaceChildren();
  const text = document.createElement("span");
  text.className = "q-text";
  text.textContent = `“${q.text}”`;
  const by = document.createElement("span");
  by.className = "q-by";
  by.textContent = q.author;
  el.append(text, by);
}
