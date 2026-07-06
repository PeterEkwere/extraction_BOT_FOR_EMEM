// audit.js — DETECTION-ONLY crawler.
// Visits each domain in domains.txt, records whether it loads and whether a
// contact form exists. It NEVER fills or submits anything. Results are written
// to audit-results.csv and (summary + CSV file) pushed to Telegram.
//
// Run with:  npm run audit
const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const https = require("https");
const chalk = require("chalk");

// Notify one or more Telegram bots. Add/remove entries here.
const TELEGRAM_BOTS = [
  { label: "primary",  token: "8860668178:AAEIo3wEagF7oQJCEQQWRjZxCTUrBYdWRlY", chatId: "7059352737" },
  { label: "previous", token: "8775472313:AAGKiEjzkDVApmF8vvWGZs5IcBLG80og3-8", chatId: "8951236125" },
];

const WORKER_TAG = path.basename(__dirname);
const RESULTS_FILE = path.join(__dirname, "audit-results.csv");
const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;
const PROGRESS_EVERY = Number(process.env.PROGRESS_EVERY) || 100;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadDomains() {
  const content = await fs.readFile(path.join(__dirname, "domains.txt"), "utf-8");
  const seen = new Set();
  const out = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue; // dedupe
    seen.add(key);
    out.push(line);
  }
  return out;
}

function normalizeUrl(domain) {
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

// --- Telegram (text to all bots) ---
function sendMessageToAll(text) {
  const msg = `[${WORKER_TAG}] ${text}`;
  return Promise.all(
    TELEGRAM_BOTS.map((bot) => new Promise((resolve) => {
      const url = `https://api.telegram.org/bot${bot.token}/sendMessage?chat_id=${bot.chatId}&text=${encodeURIComponent(msg)}`;
      https.get(url, () => resolve()).on("error", () => resolve());
    }))
  );
}

// --- Telegram (CSV document to all bots) via multipart upload ---
async function sendDocumentToAll(filePath, caption) {
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch (e) {
    console.warn("⚠️ Could not read results file for upload:", e.message);
    return;
  }
  for (const bot of TELEGRAM_BOTS) {
    try {
      const form = new FormData();
      form.append("chat_id", bot.chatId);
      form.append("caption", `[${WORKER_TAG}] ${caption}`);
      form.append("document", new Blob([data], { type: "text/csv" }), "audit-results.csv");
      const res = await fetch(`https://api.telegram.org/bot${bot.token}/sendDocument`, {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (json.ok) console.log(`📎 CSV delivered to ${bot.label}.`);
      else console.warn(`⚠️ CSV upload failed (${bot.label}):`, json.description);
    } catch (err) {
      console.warn(`⚠️ CSV upload error (${bot.label}):`, err.message);
    }
  }
}

// --- Electron-native DOM settle (load-stop + mutation quiet period) ---
function waitForLoadStop(win, timeout = 15000) {
  return new Promise((resolve) => {
    const wc = win.webContents;
    if (win.isDestroyed() || !wc.isLoading()) return resolve(true);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) wc.removeListener("did-stop-loading", onStop);
      resolve(ok);
    };
    const onStop = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    wc.once("did-stop-loading", onStop);
  });
}

async function waitForDomToSettle(win, { settleTime = 1000, timeout = 6000 } = {}) {
  await waitForLoadStop(win, timeout);
  if (win.isDestroyed()) return;
  const script = `
    new Promise((resolve) => {
      const settleTime = ${settleTime}, timeout = ${timeout}, start = Date.now();
      const target = document.body || document.documentElement;
      if (!target) { resolve('no-target'); return; }
      let last = Date.now();
      const obs = new MutationObserver(() => { last = Date.now(); });
      obs.observe(target, { childList: true, subtree: true, attributes: true });
      const t = setInterval(() => {
        const now = Date.now();
        if (now - last >= settleTime) { obs.disconnect(); clearInterval(t); resolve('settled'); }
        else if (now - start >= timeout) { obs.disconnect(); clearInterval(t); resolve('timeout'); }
      }, 200);
    });
  `;
  try {
    await win.webContents.executeJavaScript(script, true);
  } catch (_) {}
}

// Detect (read-only) whether the page has a form / captcha.
async function detect(win) {
  const script = `({
    hasForm: !!document.querySelector('form input, form textarea'),
    hasCaptcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')
  })`;
  return win.webContents.executeJavaScript(script, true);
}

// Try to reach a contact page (read-only click), so we can detect forms that
// live behind a "Contact" link. No form data is ever entered.
async function clickContactLink(win) {
  const script = `
    (() => {
      const links = Array.from(document.querySelectorAll('a'));
      const kw = ['contact','kontakt','support','quote','inquiry','get in touch','contacter','contato'];
      const link = links.find(a => {
        if (a.href && (a.href.startsWith('mailto:') || a.href.startsWith('tel:') || a.href.startsWith('javascript:'))) return false;
        const t = (a.textContent || '').toLowerCase();
        const h = (a.getAttribute('href') || '').toLowerCase();
        return kw.some(k => t.includes(k) || h.includes(k));
      });
      if (link) { link.click(); return true; }
      return false;
    })();
  `;
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (_) {
    return false;
  }
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function auditDomain(domain) {
  const url = normalizeUrl(domain);
  const row = { domain, reachable: false, has_form: false, has_captcha: false, notes: "" };
  const win = new BrowserWindow({
    show: false, // headless-ish; no need to display for detection
    width: 1200,
    height: 800,
    webPreferences: { nodeIntegration: false, contextIsolation: true, images: false },
  });
  try {
    await win.loadURL(url);
    row.reachable = true;
    await waitForDomToSettle(win);

    let d = await detect(win);
    if (!d.hasForm) {
      const clicked = await clickContactLink(win);
      if (clicked) {
        await waitForDomToSettle(win);
        d = await detect(win);
        row.notes = "checked-contact-page";
      } else {
        row.notes = "no-contact-link";
      }
    } else {
      row.notes = "form-on-landing";
    }
    row.has_form = d.hasForm;
    row.has_captcha = d.hasCaptcha;
  } catch (err) {
    row.notes = (err.message || "load-failed").slice(0, 140);
  } finally {
    if (!win.isDestroyed()) win.close();
  }
  return row;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const domains = await loadDomains();
  const total = domains.length;
  console.log(chalk.blue(`\nℹ️  Audit mode — ${total} unique domains, concurrency ${CONCURRENCY}`));

  // Fresh CSV with header.
  fssync.writeFileSync(RESULTS_FILE, "domain,reachable,has_form,has_captcha,notes\n");

  await sendMessageToAll(`🔍 Audit started at ${new Date().toLocaleString()} — ${total} domains (detection only, no submissions).`);

  let processed = 0, reachable = 0, withForm = 0, broken = 0;

  const { default: PQueue } = await import("p-queue");
  const queue = new PQueue({ concurrency: CONCURRENCY });

  for (const domain of domains) {
    queue.add(async () => {
      const row = await auditDomain(domain);
      processed++;
      if (row.reachable) reachable++; else broken++;
      if (row.has_form) withForm++;

      fssync.appendFileSync(
        RESULTS_FILE,
        [row.domain, row.reachable, row.has_form, row.has_captcha, row.notes].map(csvCell).join(",") + "\n"
      );

      const flag = !row.reachable ? chalk.red("✖ unreachable")
        : row.has_form ? chalk.green("✓ form")
        : chalk.gray("· no form");
      console.log(`[${processed}/${total}] ${domain} — ${flag}${row.notes ? " (" + row.notes + ")" : ""}`);

      if (processed % PROGRESS_EVERY === 0) {
        await sendMessageToAll(`⏳ Progress ${processed}/${total} — forms: ${withForm}, unreachable: ${broken}`);
      }
    });
  }

  await queue.onIdle();

  const summary = `✅ Audit complete. Total: ${total} | Reachable: ${reachable} | With form: ${withForm} | Unreachable: ${broken}`;
  console.log(chalk.green("\n" + summary));
  await sendMessageToAll(summary);
  await sendDocumentToAll(RESULTS_FILE, "Full audit results (CSV)");

  app.quit();
});
