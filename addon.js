const { addonBuilder } = require('stremio-addon-sdk');
const fetch = require('node-fetch').default || global.fetch || require('node-fetch');

// Cache structures
const cache = {
  sports: [],
  sportsLastFetched: 0,
  matches: [],
  matchesLastFetched: 0
};

const CACHE_TTL_SPORTS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_TTL_MATCHES = 30 * 60 * 1000; // 30 minutes

async function getSports() {
  if (Date.now() - cache.sportsLastFetched < CACHE_TTL_SPORTS && cache.sports.length > 0) {
    return cache.sports;
  }
  try {
    const res = await fetch('https://streamed.pk/api/sports');
    const data = await res.json();
    cache.sports = data;
    cache.sportsLastFetched = Date.now();
    return data;
  } catch (e) {
    console.error("Error fetching sports:", e);
    return [];
  }
}

async function getMatches() {
  if (Date.now() - cache.matchesLastFetched < CACHE_TTL_MATCHES && cache.matches.length > 0) {
    return cache.matches;
  }
  try {
    const res = await fetch('https://streamed.pk/api/matches/all-today');
    let data = await res.json();
    
    // Also fetch live
    try {
      const liveRes = await fetch('https://streamed.pk/api/matches/live');
      const liveData = await liveRes.json();
      // add live data avoiding duplicates
      for (const lm of liveData) {
        if (!data.find(m => m.id === lm.id)) {
          data.push(lm);
        }
      }
    } catch(err) {
      console.log("Error fetching live", err);
    }

    cache.matches = data;
    cache.matchesLastFetched = Date.now();
    return data;
  } catch (e) {
    console.error("Error fetching matches:", e);
    return [];
  }
}

async function buildManifest() {
  const sports = await getSports();
  const genres = sports.map(s => s.name);
  if (!genres.includes("All")) {
    // Genres usually are used for filtering
    genres.unshift("All");
  }

  return {
    id: 'org.streamedpk.sports',
    version: '1.0.0',
    name: 'Streamed Live Sports',
    description: 'Watch live sports from streamed.pk with direct stream extraction.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: ['strmpk_'],
    catalogs: [
      {
        type: 'tv',
        id: 'strmpk_sports',
        name: 'Live Sports',
        extra: [
          {
            name: 'genre',
            isRequired: false,
            options: genres
          }
        ]
      }
    ]
  };
}

// We'll create the builder initialization inside a factory since manifest is async
const puppeteer = require('puppeteer');

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ 
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
  }
  return browserPromise;
}

// Memory cache for extracted m3u8 URLs
const resolvedStreamsCache = {};

async function extractM3u8(embedUrl) {
  if (resolvedStreamsCache[embedUrl]) {
    // Cache for 2 hours (or until server restarts)
    if (Date.now() - resolvedStreamsCache[embedUrl].time < 2 * 60 * 60 * 1000) {
      return resolvedStreamsCache[embedUrl].m3u8;
    }
  }

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    let m3u8Url = null;

    const timeoutPromise = new Promise(resolve => setTimeout(resolve, 15000));
    const m3u8Promise = new Promise(resolve => {
      page.on('request', request => {
        if (request.url().includes('.m3u8')) {
          const url = request.url();
          if (!m3u8Url) {
            m3u8Url = url;
            resolve(url);
          }
        }
      });
    });

    try {
      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch(e) {}

    await Promise.race([m3u8Promise, timeoutPromise]);
    await page.close().catch(()=>{});

    if (m3u8Url) {
      resolvedStreamsCache[embedUrl] = { m3u8: m3u8Url, time: Date.now() };
    }
    return m3u8Url;
  } catch(e) {
    if (page) await page.close().catch(()=>{});
    return null;
  }
}

async function getAddon() {
  const manifest = await buildManifest();
  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== 'tv' || id !== 'strmpk_sports') return { metas: [] };
    
    let matches = await getMatches();
    
    let genre = extra.genre;
    if (genre && genre !== "All") {
      const sports = await getSports();
      const sportId = sports.find(s => s.name === genre)?.id;
      if (sportId) {
        matches = matches.filter(m => m.category === sportId);
      }
    }

    const metas = matches.map(match => {
      let description = `Match: ${match.title}\n`;
      if (match.teams?.home && match.teams?.away) {
        description += `${match.teams.home.name} vs ${match.teams.away.name}\n`;
      }
      description += `Start Time: ${new Date(match.date).toLocaleString()}\n`;
      description += `Sport: ${match.category.toUpperCase()}`;

      let poster = match.poster ? match.poster : (match.teams?.home?.badge || null);
      if (poster && poster.startsWith('/')) {
        poster = 'https://streamed.pk' + poster;
      }

      return {
        id: 'strmpk_' + match.id,
        type: 'tv',
        name: match.title,
        posterShape: 'landscape',
        poster: poster,
        description: description
      };
    });

    return { metas };
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== 'tv' || !id.startsWith('strmpk_')) return { meta: {} };

    const matches = await getMatches();
    const matchId = id.replace('strmpk_', '');
    const match = matches.find(m => m.id === matchId);

    if (!match) return { meta: {} };

    let description = `Match: ${match.title}\n`;
    if (match.teams?.home && match.teams?.away) {
      description += `${match.teams.home.name} vs ${match.teams.away.name}\n`;
    }
    description += `Start: ${new Date(match.date).toLocaleString()}\n`;
    description += `Sport: ${match.category}`;

    let poster = match.poster ? match.poster : (match.teams?.home?.badge || null);
    if (poster && poster.startsWith('/')) {
      poster = 'https://streamed.pk' + poster;
    }

    return {
      meta: {
        id: id,
        type: 'tv',
        name: match.title,
        posterShape: 'landscape',
        poster: poster,
        description: description,
        background: poster
      }
    };
  });

  builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== 'tv' || !id.startsWith('strmpk_')) return { streams: [] };

    const matches = await getMatches();
    const matchId = id.replace('strmpk_', '');
    const match = matches.find(m => m.id === matchId);

    if (!match || !match.sources) return { streams: [] };

    let allStreams = [];

    // Fetch stream info for each source from streamed.pk
    for (const source of match.sources) {
      try {
        const res = await fetch(`https://streamed.pk/api/stream/${source.source}/${source.id}`);
        const streamData = await res.json();
        allStreams.push(...streamData);
      } catch (e) {}
    }

    const streams = [];

    // To prevent Stremio from timing out, we only extract the first valid direct stream inline
    let extractedM3u8 = null;
    let refererUrl = 'https://embedsports.top/'; // fallback
    let bestStream = allStreams.find(s => s.embedUrl);
    
    if (bestStream) {
      extractedM3u8 = await extractM3u8(bestStream.embedUrl);
      try {
        refererUrl = new URL(bestStream.embedUrl).origin + '/';
      } catch(e){}
    }

    for (const strm of allStreams) {
      if (!strm.embedUrl) continue;
      
      const isBestStream = (strm === bestStream);
      const title = `Direct Stream (${strm.language} ${strm.hd ? 'HD' : 'SD'}) [${strm.source.toUpperCase()}]`;
      const fallbackTitle = `Open in Browser (${strm.language} ${strm.hd ? 'HD' : 'SD'}) [${strm.source.toUpperCase()}]`;

      if (isBestStream && extractedM3u8) {
         streams.push({
          name: "Streamed (Direct)",
          title: title,
          url: extractedM3u8,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                "Referer": refererUrl,
                "Origin": refererUrl,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
              }
            }
          }
        });
      }

      streams.push({
        name: "Streamed (Ext)",
        title: fallbackTitle,
        externalUrl: strm.embedUrl
      });
    }

    return { streams };
  });

  return builder.getInterface();
}

module.exports = getAddon;
