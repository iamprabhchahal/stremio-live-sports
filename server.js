const express = require('express');
const cors = require('cors');
const { getRouter } = require('stremio-addon-sdk');
const puppeteer = require('puppeteer');
const getAddon = require('./addon');

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ 
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
  }
  return browserPromise;
}

const app = express();
app.use(cors());

// Resolve endpoint for getting the direct m3u8
app.get('/resolve/:b64Url', async (req, res) => {
  try {
    const embedUrl = Buffer.from(req.params.b64Url, 'base64').toString('utf-8');
    if (!embedUrl || !embedUrl.startsWith('http')) {
      return res.status(400).send("Invalid embed URL");
    }

    console.log(`[Resolve] Request for: ${embedUrl}`);
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    let m3u8Url = null;

    // Set a timeout promise to stop waiting if it takes too long
    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 15000));
    
    // Intercept network requests specifically for m3u8
    const m3u8Promise = new Promise(resolve => {
      page.on('request', request => {
        if (request.url().includes('.m3u8')) {
          const url = request.url();
          // avoid short playlists that might be ad breaks if possible, but taking the first one is the best bet here
          if (!m3u8Url) {
              m3u8Url = url;
              resolve(url);
          }
        }
      });
    });

    try {
      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch(e) {
      console.log(`[Resolve] Navigation timeout or error, continuing to wait for m3u8`);
    }

    // Wait until either m3u8 is found, or timeout
    const result = await Promise.race([m3u8Promise, timeoutPromise]);
    
    if (m3u8Url) {
      console.log(`[Resolve] Found m3u8: ${m3u8Url}`);
      // Redirect Stremio player directly to the m3u8
      res.redirect(302, m3u8Url);
    } else {
      console.log(`[Resolve] Failed to find m3u8 for: ${embedUrl}`);
      // Send a 404 or a dummy fallback
      res.status(404).send("Could not extract stream.");
    }

    await page.close().catch(e => console.error("Error closing page", e));
  } catch (err) {
    console.error(`[Resolve] Error:`, err);
    res.status(500).send(`Internal Server Error: ${err.message}\n\nStack:\n${err.stack}`);
  }
});

const PORT = process.env.PORT || 7000;

getAddon().then(addonInterface => {
  const streamRouter = getRouter(addonInterface);
  app.use(streamRouter);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Stremio Addon active at: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`Resolve Proxy active.`);
    if (!process.env.ADDON_URL) {
      console.log(`\nWARNING: ADDON_URL environment variable is not set.`);
      console.log(`If deployed remotely, streams will try to redirect to localhost.`);
      console.log(`Set ADDON_URL (e.g. ADDON_URL=https://my-app.onrender.com) before deploying!`);
    }
  });
}).catch(err => {
  console.error("Failed to initialize addon:", err);
});
