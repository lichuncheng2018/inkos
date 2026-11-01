export interface PhoneReaderPageInput {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
}

export function buildPhoneReaderHtml(input: PhoneReaderPageInput): string {
  const url = input.supabaseUrl.replace(/\/+$/u, "");
  const key = input.publishableKey;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>InkOS</title>
<style>
:root { --bg:#16110c; --ink:#ede0c8; --muted:#9a8b74; --seal:#c45c26; --panel:#1c1916; }
* { box-sizing:border-box; }
html,body { margin:0; min-height:100%; background:var(--bg); color:var(--ink);
  font-family:"Songti SC","Noto Serif SC","STSong","SimSun",serif; }
body { touch-action:pan-y; }
#chrome { position:sticky; top:0; z-index:2; display:flex; align-items:center; gap:8px;
  padding:12px 16px calc(12px + env(safe-area-inset-top)); background:color-mix(in srgb, var(--bg) 92%, black);
  border-bottom:1px solid color-mix(in srgb, var(--seal) 35%, transparent); }
#chrome.hidden { transform:translateY(-110%); }
#title { flex:1; min-width:0; font-size:15px; letter-spacing:.12em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
button { appearance:none; border:0; background:transparent; color:var(--muted); font:inherit; padding:6px 8px; }
#page { max-width:42rem; margin:0 auto; padding:28px 22px 120px; min-height:70vh; }
h1 { font-size:22px; font-weight:600; text-align:center; color:var(--seal); letter-spacing:.18em; margin:0 0 28px; }
p { margin:0 0 1.15em; font-size:19px; line-height:1.9; text-indent:2em; }
#hint { text-align:center; color:var(--muted); font-size:13px; letter-spacing:.2em; margin:24px 0 0; }
#toc { display:none; position:fixed; inset:0; background:color-mix(in srgb, var(--panel) 96%, black); overflow:auto; padding:72px 20px 40px; z-index:3; }
#toc.open { display:block; }
#toc a { display:block; color:var(--ink); text-decoration:none; padding:12px 8px; border-bottom:1px solid #2a241c; }
#books a { display:block; color:var(--ink); text-decoration:none; padding:18px 8px; border-bottom:1px solid #2a241c; font-size:18px; }
</style>
</head>
<body>
<header id="chrome">
  <button id="tocBtn" type="button">目录</button>
  <div id="title">InkOS</div>
  <button id="prevBtn" type="button">上一章</button>
  <button id="nextBtn" type="button">下一章</button>
</header>
<main id="page"></main>
<nav id="toc"></nav>
<script>
const URL = ${JSON.stringify(url)};
const KEY = ${JSON.stringify(key)};
const headers = { apikey: KEY, Authorization: "Bearer " + KEY };
const page = document.getElementById("page");
const toc = document.getElementById("toc");
const titleEl = document.getElementById("title");
const chrome = document.getElementById("chrome");
let bookId = decodeURIComponent((location.hash || "#").slice(1));
let chapters = [];
let index = 0;
let chromeOn = true;

function rest(path) {
  return fetch(URL + "/rest/v1/" + path, { headers }).then(function (res) {
    if (!res.ok) throw new Error("load failed " + res.status);
    return res.json();
  });
}
function showChrome(on) {
  chromeOn = on;
  chrome.classList.toggle("hidden", !on);
}
function render() {
  const ch = chapters[index];
  if (!ch) {
    page.innerHTML = "<p style=\\"text-indent:0;color:var(--muted)\\">还没有章节。</p>";
    return;
  }
  document.title = ch.title;
  titleEl.textContent = ch.title;
  const paras = String(ch.content || "").split(/\\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean);
  page.innerHTML = "<h1>" + escapeHtml(ch.title) + "</h1>" +
    paras.map(function (p) { return "<p>" + escapeHtml(p).replace(/\\n/g, "<br>") + "</p>"; }).join("") +
    "<p id=\\"hint\\">本章完 · 点左右翻页</p>";
  localStorage.setItem("inkos-read:" + bookId, String(index));
  history.replaceState(null, "", "#" + encodeURIComponent(bookId));
  window.scrollTo(0, 0);
}
function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c];
  });
}
function go(delta) {
  const next = index + delta;
  if (next < 0 || next >= chapters.length) return;
  index = next;
  render();
}
document.getElementById("prevBtn").onclick = function () { go(-1); };
document.getElementById("nextBtn").onclick = function () { go(1); };
document.getElementById("tocBtn").onclick = function () { toc.classList.toggle("open"); };
page.addEventListener("click", function (event) {
  const x = event.clientX / window.innerWidth;
  if (x < 0.28) go(-1);
  else if (x > 0.72) go(1);
  else showChrome(!chromeOn);
});
let startX = 0;
page.addEventListener("touchstart", function (event) { startX = event.changedTouches[0].clientX; }, { passive: true });
page.addEventListener("touchend", function (event) {
  const dx = event.changedTouches[0].clientX - startX;
  if (dx > 60) go(-1);
  else if (dx < -60) go(1);
});

async function openBook(id) {
  bookId = id;
  chapters = await rest("inkos_chapters?book_id=eq." + encodeURIComponent(id) + "&select=chapter_no,title,content&order=chapter_no");
  const remembered = Number(localStorage.getItem("inkos-read:" + id) || "0");
  index = Number.isInteger(remembered) && remembered >= 0 && remembered < chapters.length ? remembered : 0;
  toc.innerHTML = chapters.map(function (ch, i) {
    return "<a href=\\"#\\" data-i=\\"" + i + "\\">" + escapeHtml(ch.title) + "</a>";
  }).join("");
  toc.onclick = function (event) {
    const i = event.target && event.target.getAttribute && event.target.getAttribute("data-i");
    if (i == null) return;
    event.preventDefault();
    index = Number(i);
    toc.classList.remove("open");
    render();
  };
  render();
}

async function boot() {
  if (bookId) {
    try { await openBook(bookId); return; }
    catch (error) { page.innerHTML = "<p style=\\"text-indent:0\\">打开失败：" + escapeHtml(error.message) + "</p>"; }
  }
  const books = await rest("inkos_books?select=id,title&order=updated_at.desc");
  titleEl.textContent = "InkOS";
  page.innerHTML = "<h1>书架</h1><div id=\\"books\\">" + books.map(function (book) {
    return "<a href=\\"#\\" data-id=\\"" + escapeHtml(book.id) + "\\">" + escapeHtml(book.title || book.id) + "</a>";
  }).join("") + "</div>";
  page.onclick = function (event) {
    const id = event.target && event.target.getAttribute && event.target.getAttribute("data-id");
    if (!id) return;
    event.preventDefault();
    page.onclick = null;
    openBook(id);
  };
}
boot().catch(function (error) {
  page.innerHTML = "<p style=\\"text-indent:0\\">连不上书库：" + escapeHtml(error.message) + "</p>";
});
</script>
</body>
</html>
`;
}

export function phoneReaderPublicUrl(supabaseUrl: string, bookId?: string): string {
  const origin = supabaseUrl.replace(/\/+$/u, "");
  const base = `${origin}/storage/v1/object/public/inkos-reader/index.html`;
  return bookId ? `${base}#${encodeURIComponent(bookId)}` : base;
}
