

const fs = require('fs');
const puppeteer = require('puppeteer');

async function test() {
  let log = "";
  const l = (msg) => { console.log(msg); log += msg + "\n"; };

  l("Fetching live matches...");
  const matchesRes = await fetch('https://streamed.pk/api/matches/live');
  const matches = await matchesRes.json();
  if (!matches || matches.length === 0) {
    l("No live matches right now.");
    return;
  }

  let stream = null;
  let source = null;
  let match = null;

  for (let m of matches) {
    if (!m.sources || m.sources.length === 0) continue;
    for (let s of m.sources) {
      const streamRes = await fetch(`https://streamed.pk/api/stream/${s.source}/${s.id}`);
      const streams = await streamRes.json();
      if (streams && streams.length > 0) {
        stream = streams[0];
        source = s;
        match = m;
        break;
      }
    }
    if (stream) break;
  }

  if (!stream) return l("No streams found in any match.");

  l("Found match: " + match.title);
  l("Fetching stream for source: " + source.source + " " + source.id);
  l("Embed URL: " + stream.embedUrl);

  l("Launching Puppeteer...");
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  let m3u8Url = null;
  // Intercept network requests
  page.on('request', request => {
    if (request.url().includes('.m3u8')) {
      m3u8Url = request.url();
      l("FOUND M3U8 via Puppeteer: " + m3u8Url);
    }
  });

  l("Navigating to embed...");
  try {
    await page.goto(stream.embedUrl, { waitUntil: 'networkidle2', timeout: 15000 });
  } catch(e) {
    l("Navigation complete or timed out");
  }

  // Wait a bit more to see if player loads
  if (!m3u8Url) {
    l("Waiting 5s extra...");
    await new Promise(r => setTimeout(r, 5000));
  }

  await browser.close();
  l("Puppeteer done.");
  fs.writeFileSync('output_utf8.txt', log, 'utf-8');
}

test().catch(e => console.error(e));
