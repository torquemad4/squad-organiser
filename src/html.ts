// Tiny HTML templating: interpolated values are escaped unless they are already Html.

export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

type Value = Html | string | number | boolean | null | undefined | Value[];

export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(render).join("");
  if (v instanceof Html) return v.value;
  return escape(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): Html {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Html(out);
}

export interface Nav {
  appName: string;
  user: { name: string | null; email: string } | null;
  isCaptain: boolean;
  isAdmin: boolean;
  active?: "tournaments" | "me" | "draft";
}

export function page(title: string, nav: Nav, body: Html, status = 200): Response {
  const link = (href: string, label: string, key: Nav["active"]) =>
    html`<a href="${href}" class="${nav.active === key ? "active" : ""}">${label}</a>`;
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${nav.appName}</title>
<link rel="icon" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top">
  <a href="/" class="brand"><img src="/logo.png" alt="" width="30" height="41"><span>${nav.appName}</span></a>
  <nav>
    ${link("/", "Tournaments", "tournaments")}
    ${nav.user ? link("/me", "My sign-ups", "me") : null}
    ${nav.isCaptain || nav.isAdmin ? link("/draft", "Draft", "draft") : null}
    ${nav.user
      ? html`<form method="post" action="/logout" class="inline"><button class="link">Sign out</button></form>`
      : html`<a href="/login">Sign in</a>`}
  </nav>
</header>
<main>
${body}
</main>
<script>
document.addEventListener("submit", (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});
</script>
</body>
</html>`;
  return new Response(doc.value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
