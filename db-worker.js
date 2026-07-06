const { app, BrowserWindow } = require("electron");
const fs = require("fs/promises");
const path = require("path");
const https = require("https");
const chalk = require("chalk");

let formData = {};
TELEGRAM_BOT_TOKEN = "8860668178:AAEIo3wEagF7oQJCEQQWRjZxCTUrBYdWRlY";
TELEGRAM_CHAT_ID = "7059352737";

// Tag to identify which worker instance is running (derived from folder name)
const WORKER_TAG = path.basename(__dirname);

async function loadDomains() {
  const content = await fs.readFile("domains.txt", "utf-8");
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
}

// (window concurrency tracking defined later near createWindow)

async function loadSkipDomains() {
  try {
    const content = await fs.readFile("skip-domains.txt", "utf-8");
    return new Set(
      content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"))
        .map(domain => {
          // Remove protocol and www. for consistent matching
          return domain
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .split('/')[0]; // Remove paths
        })
    );
  } catch (error) {
    console.log(chalk.yellow("⚠️  skip-domains.txt not found. No domains will be skipped."));
    return new Set();
  }
}

async function loadFormData() {
  const raw = await fs.readFile("ali-data.json", "utf-8");
  return JSON.parse(raw);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function autoClickPopups(win) {
  const script = `
    (() => {
      const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
      const consent = buttons.find(btn => /accept|agree|consent|continue/i.test(btn.textContent || btn.value || ''));
      if (consent) {
        consent.click();
        return true;
      }
      return false;
    })();
  `;
  try {
    const clicked = await win.webContents.executeJavaScript(script);
    if (clicked) console.log("🔘 Clicked popup consent button.");
  } catch (err) {
    console.error("❌ Error handling popups:", err.message);
  }
}

async function clickContactLink(win) {
  const clickScript = `
    (() => {
      const links = Array.from(document.querySelectorAll('a'));
      
      // Filter out mailto: links and other non-http links
      const contactLink = links.find(link => {
        // Skip if it's a mailto: link or other non-http link
        if (link.href && (link.href.startsWith('mailto:') || 
                         link.href.startsWith('tel:') || 
                         link.href.startsWith('javascript:'))) {
          return false;
        }
        
        // Check link text/content for contact-related keywords
        const linkText = (link.textContent || link.innerText || '').toLowerCase().trim();
        const linkHref = (link.getAttribute('href') || '').toLowerCase();
        
        // Keywords to identify contact links
        const contactKeywords = [
          'contact', 'kontakt', 'support', 'quote', 'inquiry', 
          'get in touch', 'get a quote', 'contacter', 'kontaktieren', 
          'contato', 'contáctenos', 'kontaktujte', 'kapcsolat', 
          'контакт', 'اتصل', '联络', '联系', 'お問い合わせ',
          'reach out', 'message us', 'email us', 'call us'
        ];
        
        // Check if text or href contains contact keywords
        return contactKeywords.some(keyword => 
          linkText.includes(keyword) || 
          linkHref.includes(keyword) ||
          (link.getAttribute('class') || '').toLowerCase().includes(keyword) ||
          (link.getAttribute('id') || '').toLowerCase().includes(keyword)
        );
      });
      
      if (contactLink) {
        console.log('Found contact link:', contactLink.href);
        contactLink.click();
        return true;
      }
      return false;
    })();
  `;
  
  try {
    const clicked = await win.webContents.executeJavaScript(clickScript);
    if (clicked) {
      console.log("🔗 Contact link clicked. Waiting to load...");
      return true;
    } else {
      console.log("⚠️ No suitable contact link found.");
      return false;
    }
  } catch (err) {
    console.error("❌ Error clicking contact link:", err.message);
    return false;
  }
}

async function waitForFormAndCaptcha(win, timeout = 20000) {
  const checkScript = `
    ({
      hasForm: !!document.querySelector('form input, form textarea'),
      hasCaptcha: !!document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]')
    });
  `;

  const start = Date.now();
  let result = { hasForm: false, hasCaptcha: false };

  while (Date.now() - start < timeout) {
    result = await win.webContents.executeJavaScript(checkScript);
    if (result.hasForm) break;
    await delay(1000);
  }
  return result;
}

// Node-side wait for the page to stop loading (idiomatic Electron approach).
// Resolves true once webContents fires 'did-stop-loading', false on timeout.
function waitForLoadStop(win, timeout = 20000) {
  return new Promise((resolve) => {
    const wc = win.webContents;
    if (win.isDestroyed() || !wc.isLoading()) {
      resolve(true);
      return;
    }
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

// Waits for the DOM to settle: first the load event at the Electron level,
// then a quiet period with no mutations. The result IS respected by callers
// (unlike the old version), and a missing <body> no longer throws.
async function waitForDomToSettle(win, { settleTime = 1200, timeout = 8000 } = {}) {
  await waitForLoadStop(win, timeout);
  if (win.isDestroyed()) return "destroyed";

  const script = `
    new Promise((resolve) => {
      const settleTime = ${settleTime};
      const timeout = ${timeout};
      const start = Date.now();
      const target = document.body || document.documentElement;
      if (!target) { resolve('no-target'); return; }
      let lastChange = Date.now();
      const observer = new MutationObserver(() => { lastChange = Date.now(); });
      observer.observe(target, { childList: true, subtree: true, attributes: true });
      const timer = setInterval(() => {
        const now = Date.now();
        if (now - lastChange >= settleTime) {
          observer.disconnect(); clearInterval(timer); resolve('settled');
        } else if (now - start >= timeout) {
          observer.disconnect(); clearInterval(timer); resolve('timeout');
        }
      }, 250);
    });
  `;
  try {
    const result = await win.webContents.executeJavaScript(script, true);
    if (result === "settled") console.log("✅ DOM settled.");
    else if (result === "timeout") console.warn("⚠️ DOM still busy after timeout — proceeding anyway.");
    else console.warn(`⚠️ DOM settle: ${result}.`);
    return result;
  } catch (err) {
    console.error("❌ Error waiting for DOM to settle:", err.message);
    return "error";
  }
}

function notifyTelegram(domain) {
  const message = encodeURIComponent(`[${WORKER_TAG}] ⚠️ CAPTCHA detected at ${domain}. Manual input needed.`);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${message}`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      console.log("📬 Telegram notified.");
      resolve();
    }).on("error", (err) => {
      console.warn("⚠️ Telegram notify failed:", err.message);
      resolve();
    });
  });
}

// Generic Telegram sender for start/progress/end messages
function sendTelegramMessage(text) {
  const message = encodeURIComponent(`[${WORKER_TAG}] ${text}`);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${message}`;
  return new Promise((resolve) => {
    https
      .get(url, () => resolve())
      .on("error", (err) => {
        console.warn("⚠️ Telegram message failed:", err.message);
        resolve();
      });
  });
}

// Finds and clicks the submit control for the contact form. Prefers real
// submit buttons/inputs, falls back to buttons whose text looks like "send",
// and finally to form.requestSubmit(). Returns a label string on success, null
// if nothing submittable was found.
async function clickSubmit(win) {
  const script = `
    (() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const submitText = /submit|send|senden|absenden|envoyer|enviar|invia|verzenden|отправить|送信|contact us|get in touch|send message|send inquiry|request/i;

      const candidates = [];
      // 1) explicit submit controls (inside forms first, then anywhere)
      document.querySelectorAll('form button[type="submit"], form input[type="submit"]').forEach(el => candidates.push(el));
      document.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(el => candidates.push(el));
      // 2) buttons/links whose text reads like a submit action
      document.querySelectorAll('button, input[type="button"], a[role="button"], [role="button"]').forEach(el => {
        if (submitText.test((el.textContent || el.value || '').trim())) candidates.push(el);
      });

      const btn = candidates.find(isVisible);
      if (btn) {
        btn.click();
        return (btn.textContent || btn.value || 'submit').trim().slice(0, 60);
      }

      // 3) last resort: submit the form that holds the visible fields
      const form = Array.from(document.querySelectorAll('form'))
        .find(f => f.querySelector('input:not([type="hidden"]), textarea'));
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return 'form.submit()';
      }
      return null;
    })();
  `;
  try {
    const label = await win.webContents.executeJavaScript(script, true);
    if (label) {
      console.log(`📨 Submit triggered: "${label}"`);
      return label;
    }
    console.log("⚠️ No submit control found.");
    return null;
  } catch (err) {
    console.error("❌ Error clicking submit:", err.message);
    return null;
  }
}

async function fillForms(win, data, domain) {
  const { hasForm, hasCaptcha } = await waitForFormAndCaptcha(win);
  if (!hasForm) {
    console.log("⚠️ No form found to fill.");
    return { hasForm: false, hadCaptcha: hasCaptcha };
  }

  await waitForDomToSettle(win);

  const interactScript = `
    (() => {
      window.scrollTo(0, 100);
      const firstInput = document.querySelector('input, textarea');
      if (firstInput) firstInput.focus();
      const event = new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 });
      document.dispatchEvent(event);
    })();
  `;
  try {
    await win.webContents.executeJavaScript(interactScript);
    console.log("🖱️ Simulated user interaction.");
    await delay(3000);
  } catch (err) {
    console.warn("⚠️ User interaction simulation failed:", err.message);
  }

  const fieldMap = {
    name: data.name,
    email: data.email,
    message: data.message,
    phone: data.phone || '',
    subject: data.subject || '',
    firstname: data["first name"] || data.name,
    lastname: data["last name"] || data.name,
    company: data.company || '',
    country: data.country || '',
    job: data["job title"] || ''
  };

  const script = `
    (function() {
      // Helper function to trigger all necessary events
      function setNativeValue(element, value) {
        const { set: valueSetter = null } = Object.getOwnPropertyDescriptor(element, 'value') || {};
        const prototype = Object.getPrototypeOf(element);
        const { set: prototypeValueSetter = null } = Object.getOwnPropertyDescriptor(prototype, 'value') || {};

        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
          prototypeValueSetter.call(element, value);
        } else if (valueSetter) {
          valueSetter.call(element, value);
        } else {
          element.value = value;
        }

        // Trigger all the necessary events
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      // Function to handle different input types
      function fillField(input, value) {
        if (!input) return;
        
        // Store the current active element
        const activeElement = document.activeElement;
        
        // Focus the input
        input.focus();
        
        // Handle different input types
        switch(input.type) {
          case 'checkbox':
          case 'radio':
            if (!input.checked) input.click();
            break;
          case 'select-one':
          case 'select-multiple':
            input.value = value;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          default:
            setNativeValue(input, value);
        }
        
        // Restore focus to the previously active element
        if (activeElement) activeElement.focus();
      }

      // Process all form fields
      const inputs = document.querySelectorAll("input, textarea, select");
      inputs.forEach(input => {
        try {
          const field = (input.name || input.id || input.placeholder || '').toLowerCase();
          const type = input.type.toLowerCase();
          const tagName = input.tagName.toLowerCase();
          
          // Skip buttons and hidden inputs
          if (type === 'button' || type === 'submit' || type === 'hidden') return;
          
          // Match fields based on common patterns
          // Use JSON.stringify to properly escape special characters
          if (/first/.test(field)) fillField(input, ${JSON.stringify(fieldMap.firstname)});
          else if (/last/.test(field)) fillField(input, ${JSON.stringify(fieldMap.lastname)});
          else if (/email/.test(field)) fillField(input, ${JSON.stringify(fieldMap.email)});
          else if (/message|comment/.test(field)) fillField(input, ${JSON.stringify(fieldMap.message)});
          else if (/subject/.test(field)) fillField(input, ${JSON.stringify(fieldMap.subject)});
          else if (/phone/.test(field)) fillField(input, "${fieldMap.phone}");
          else if (/job|title/.test(field)) fillField(input, "${fieldMap.job}");
          else if (/company/.test(field)) fillField(input, "${fieldMap.company}");
          else if (/country/.test(field)) fillField(input, "${fieldMap.country}");
          else if (/name/.test(field) && !/user|login|account/.test(field)) fillField(input, "${fieldMap.name}");
        } catch (e) {
          console.error('Error filling field:', e);
        }
      });
    })();
  `;

  try {
    await win.webContents.executeJavaScript(script);
    console.log("✅ Form filled.");
  } catch (err) {
    console.error("❌ Error injecting script:", err.message);
  }

  if (hasCaptcha) {
    // Don't auto-submit through a CAPTCHA — leave it for manual completion.
    console.log("⚠️ CAPTCHA detected, notifying user. Skipping auto-submit.");
    await notifyTelegram(domain);
    return { hasForm: true, hadCaptcha: true, submitted: false };
  }

  await delay(1000);
  const submitLabel = await clickSubmit(win);
  if (submitLabel) {
    await waitForDomToSettle(win);
    console.log("✅ Form submitted.");
  }

  return { hasForm: true, hadCaptcha: false, submitted: Boolean(submitLabel) };
}

function normalizeUrl(domain) {
  // If it already has http:// or https://, return as is
  if (/^https?:\/\//i.test(domain)) {
    return domain;
  }
  // Add https:// if missing
  return `https://${domain}`;
}

// Processes a single domain in its own window. The window is closed when done
// so it never leaks — EXCEPT when a CAPTCHA was detected, in which case it is
// left open so a human can solve it (that's the whole point of the Telegram ping).
// Concurrency is bounded by the p-queue in the main handler, not by this function.
async function createWindow(domain, formData) {
  const url = normalizeUrl(domain);
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  let keepOpen = false;
  try {
    console.log(`🌐 Visiting ${url}`);
    await win.loadURL(url);
    await waitForDomToSettle(win);

    await autoClickPopups(win);

    const clicked = await clickContactLink(win);
    if (clicked) await waitForDomToSettle(win);
    await autoClickPopups(win);

    const result = await fillForms(win, formData, url);
    if (result && result.hadCaptcha) {
      keepOpen = true;
      console.log(`🧩 CAPTCHA at ${url} — leaving window open for manual input.`);
    }
  } catch (err) {
    console.error(`❌ Failed to process ${url}:`, err.message);
  } finally {
    if (!keepOpen && !win.isDestroyed()) win.close();
  }
}

// Electron/Chromium can segfault (exit 139) on some Windows/GPU setups when
// opening many windows. Disabling hardware acceleration is the standard, low-risk
// remedy. Must be called before the app is ready.
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const [domains, skipDomains] = await Promise.all([
    loadDomains(),
    loadSkipDomains()
  ]);
  
  formData = await loadFormData();
  let skippedCount = 0;
  let processedCount = 0;
  const totalDomains = domains.length;

  console.log(chalk.blue(`\nℹ️  Found ${totalDomains} domains to process`));
  if (skipDomains.size > 0) {
    console.log(chalk.yellow(`ℹ️  Loaded ${skipDomains.size} domains to skip`));
  }

  // Notify start once the app has initialized (include local time)
  await sendTelegramMessage(`🚀 App started at ${new Date().toLocaleString()} — Will process ${totalDomains} domains`);

  // Set once the queue has drained, so window churn during the run does not
  // trigger a premature quit via window-all-closed.
  let processingDone = false;

  // Centralized end notification with guard to ensure a single send
  let endNotified = false;
  const notifyEnd = async () => {
    if (endNotified) return;
    endNotified = true;
    try {
      await sendTelegramMessage(`✅ App closing. Processed: ${processedCount} | Skipped: ${skippedCount} | Total: ${totalDomains}`);
    } catch (_) {}
  };

  // Electron shutdown events
  app.on('before-quit', notifyEnd);
  app.on('quit', notifyEnd);
  app.on('will-quit', notifyEnd);
  app.on('window-all-closed', async () => {
    // Windows open and close throughout the run under bounded concurrency, so a
    // transient "no windows" state is normal. Only treat it as the end once the
    // queue has fully drained.
    if (!processingDone) return;
    await notifyEnd();
    app.quit();
  });

  // Handle terminal interruptions and fatal errors
  process.on('SIGINT', async () => { await notifyEnd(); process.exit(0); });
  process.on('SIGTERM', async () => { await notifyEnd(); process.exit(0); });
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    await notifyEnd();
    process.exit(1);
  });
  process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled rejection:', reason);
    await notifyEnd();
    process.exit(1);
  });

  // Filter out skipped domains up front so counts and the "[n/total]" progress
  // label are accurate.
  const normalizeName = (domain) => domain
    .replace(/^https?:\/\//i, '')  // case insensitive protocol removal
    .replace(/^www\./i, '')        // case insensitive www removal
    .split('/')[0]                 // remove paths
    .toLowerCase();                // normalize case for comparison

  const toProcess = [];
  for (const domain of domains) {
    if (skipDomains.has(normalizeName(domain))) {
      console.log(chalk.gray(`⏩ Skipping ${domain} (in skip list)`));
      skippedCount++;
    } else {
      toProcess.push(domain);
    }
  }
  const totalToProcess = toProcess.length;

  // Bounded concurrency via p-queue (ESM-only, so loaded with dynamic import).
  // Set CONCURRENCY env var to tune; defaults to 4.
  const CONCURRENCY = Number(process.env.CONCURRENCY) || 4;
  const { default: PQueue } = await import('p-queue');
  const queue = new PQueue({ concurrency: CONCURRENCY });
  console.log(chalk.blue(`ℹ️  Processing ${totalToProcess} domains with concurrency ${CONCURRENCY}`));

  for (const domain of toProcess) {
    queue.add(async () => {
      const n = ++processedCount;
      console.log(chalk.blue(`\n🔍 [${n}/${totalToProcess}] Processing: ${domain}`));
      await createWindow(domain, formData);
    });
  }

  await queue.onIdle();
  processingDone = true;

  console.log(chalk.green("\n✅ Processing complete!"));
  console.log(chalk`{green Processed: ${processedCount} | Skipped: ${skippedCount} | Total: ${totalDomains}}`);

  // If windows are still open (CAPTCHAs awaiting manual input), keep the app
  // alive; otherwise send the end summary and quit.
  const remaining = BrowserWindow.getAllWindows().length;
  if (remaining === 0) {
    await notifyEnd();
    app.quit();
  } else {
    console.log(chalk.yellow(`\nℹ️  ${remaining} window(s) left open for manual CAPTCHA handling. Close them when done.`));
  }
});
