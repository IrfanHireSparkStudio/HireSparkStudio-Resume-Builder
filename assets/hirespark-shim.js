/* HireSparkStudio Resume Builder — local fallback shim (GitHub Pages).
 *
 * The React app calls two backend endpoints that only exist on the AI Studio
 * backend: POST /api/parse-resume and GET /api/jobs. On GitHub Pages those
 * requests 404 (HTML), which used to crash the import with an
 * "Unexpected token" error. This shim patches window.fetch:
 *   1. It tries the REAL network request first. If it returns ok AND the body
 *      parses as JSON with the expected shape, the original response is
 *      returned untouched (so the smarter AI parsing keeps working on
 *      AI Studio).
 *   2. Otherwise it falls back to a local implementation and returns a
 *      proper JSON Response: a built-in list of 9 real board jobs, and a
 *      client-side resume parser (.txt/.md direct, .docx via vendored
 *      mammoth with a dependency-free fallback, .pdf via vendored pdf.js,
 *      images via lazy-loaded Tesseract.js from CDN).
 * Every non-API request passes through to the original fetch untouched.
 * The shim never throws: on failure it returns {parsed:null, error:...}
 * (parse-resume) or {items:[...]} so the app can show its own message.
 */
(function () {
  'use strict';
  var origFetch = window.fetch.bind(window);

  var JOBS_FALLBACK = { items: [
    { url: 'https://irfanhiresparkstudio.github.io/job-new-grad-rn-behavioral-health-retreat-doctors-hospital.html', title: 'New Grad RN Behavioral Health — Retreat Doctors\' Hospital' },
    { url: 'https://irfanhiresparkstudio.github.io/job-new-grad-rn-resident-cardiovascular-stepdown-cleveland-clinic.html', title: 'New Grad RN Resident – Cardiovascular Stepdown — Cleveland Clinic' },
    { url: 'https://irfanhiresparkstudio.github.io/job-medical-telemetry-rn-adventhealth-minneola.html', title: 'Registered Nurse, Medical Telemetry – Nights — AdventHealth Minneola' },
    { url: 'https://irfanhiresparkstudio.github.io/job-emergency-room-rn-kaiser-los-angeles.html', title: 'Emergency Room RN - Clinic — Kaiser Permanente Los Angeles' },
    { url: 'https://irfanhiresparkstudio.github.io/job-new-grad-residency-hca-aurora.html', title: 'New Grad RN Residency — HCA HealthONE Aurora' },
    { url: 'https://irfanhiresparkstudio.github.io/job-older-adult-psych-ucla.html', title: 'RN — Older Adult Psych, 4North (NPH)' },
    { url: 'https://irfanhiresparkstudio.github.io/job-float-pool-northwestern-dekalb.html', title: 'Registered Nurse — Float Pool, Full-Time Nights' },
    { url: 'https://irfanhiresparkstudio.github.io/job-icu-sutter-coast.html', title: 'Registered Nurse, ICU — Sutter Coast Hospital' },
    { url: 'https://irfanhiresparkstudio.github.io/job-emergency-nurse-upmc-trinity.html', title: 'Registered Nurse, Emergency Department — UPMC Trinity' }
  ] };

  function jsonResponse(obj) {
    return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  /* ---------------- pdf.js worker (local) ---------------- */
  try {
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
      var shimSrc = document.currentScript && document.currentScript.src;
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = shimSrc
        ? new URL('pdf.worker.min.js', shimSrc).href
        : 'assets/pdf.worker.min.js';
    }
  } catch (e) { /* non-fatal */ }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------------- text -> parsed parser ---------------- */
  var KNOWN_HEADINGS = [
    { re: /PROFESSIONAL SUMMARY/i, kind: 'summary', title: 'Professional Summary' },
    { re: /LICENSES?\s*(&|AND)\s*CERTIFICATIONS?|CERTIFICATIONS?\s*(&|AND)\s*LICENSES?/i, kind: 'licenses', title: 'Licenses & Certifications' },
    { re: /CLINICAL\s*(&|AND)\s*PROFESSIONAL EXPERIENCE|PROFESSIONAL EXPERIENCE|WORK EXPERIENCE|WORK HISTORY|EXPERIENCE/i, kind: 'experience', title: 'Clinical & Professional Experience' },
    { re: /^EDUCATION$/i, kind: 'education', title: 'Education' },
    { re: /CORE COMPETENCIES|CLINICAL SKILLS|^SKILLS$/i, kind: 'skills', title: 'Core Competencies & Clinical Skills' },
    { re: /PROFESSIONAL REFERENCES|^REFERENCES$/i, kind: 'references', title: 'Professional References' }
  ];
  var STATUS_RE = /((?:Active\s*\|\s*)?Exp\.\s*\d{2}\/\d{4}|Certified|Active)\s*$/i;
  var DATE_RANGE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s*[–—-]\s*(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}|Present|Current)\s*$/i;

  function isAllCapsHeading(line) {
    if (line.length < 3 || line.length > 80) return false;
    if (/[@\d]/.test(line)) return false;
    var letters = line.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) return false;
    return letters === letters.toUpperCase();
  }

  // A line counts as a known section heading only if it matches a known
  // heading AND has no ": " (a "Category: ..." bullet line such as
  // "Clinical Skills: ..." must never be mistaken for the SKILLS heading).
  function knownHeading(line) {
    if (/: /.test(line)) return null;
    for (var i = 0; i < KNOWN_HEADINGS.length; i++) {
      if (KNOWN_HEADINGS[i].re.test(line)) return KNOWN_HEADINGS[i];
    }
    return null;
  }

  var MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';
  var DATE_RANGE_TAIL_RE = new RegExp('^(.*?)\\s*(' + MONTHS + '\\s+\\d{4}\\s*[\\u2013\\u2014-]\\s*(?:' + MONTHS + '\\s+\\d{4}|Present|Current))\\s*$', 'i');

  function splitHeadingDate(line) {
    // "Heading ... <tab> Jan 2024 – May 2024" (tab already collapsed to space)
    var parts = line.split('\t').map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length >= 2 && DATE_RANGE_RE.test(parts[parts.length - 1])) {
      return { heading: parts.slice(0, -1).join(' ').trim(), date: parts[parts.length - 1] };
    }
    // Date range glued to the end of the heading line (mammoth drops the
    // <w:br/> in "...Chicago, I" + "Aug 2022 – Dec 2023", and the PDF/text
    // paths put it on the same line after a space).
    var dm = line.match(DATE_RANGE_TAIL_RE);
    if (dm && dm[1].trim()) {
      return { heading: dm[1].trim(), date: dm[2] };
    }
    return { heading: line, date: '' };
  }

  function parseTextToParsed(text) {
    var rawLines = text.split(/\r?\n/);
    var lines = [];
    rawLines.forEach(function (l) {
      // Collapse every whitespace run (tabs, multi-spaces from pdf.js item
      // joins) to one space. Tabs are NOT line separators: a license line
      // "heading<TAB>status" must stay one line so heading and status pair up.
      var t = l.replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
    });
    if (!lines.length) return null;

    var header = { name: '', credentials: '', title: '', phone: '', email: '', city: '', linkedin: '', license: '' };
    var first = lines[0];
    var comma = first.indexOf(',');
    if (comma > 0) { header.name = first.slice(0, comma).trim(); header.credentials = first.slice(comma + 1).trim(); }
    else { header.name = first; }

    // Header region: everything before the first recognised section heading.
    var firstHeadingIdx = -1;
    for (var i = 1; i < lines.length; i++) {
      if (knownHeading(lines[i])) { firstHeadingIdx = i; break; }
    }
    var headerEnd = firstHeadingIdx === -1 ? Math.min(lines.length, 4) : firstHeadingIdx;
    for (var j = 1; j < headerEnd; j++) {
      var L = lines[j];
      var em = L.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (em) header.email = em[0];
      var ph = L.match(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/);
      if (ph) header.phone = ph[0];
      var li = L.match(/linkedin\.com\/in\/[A-Za-z0-9_.-]+/i);
      if (li) header.linkedin = li[0];
      var lic = L.match(/RN\s*Lic\.?\s*#\s*([0-9]+)/i);
      if (lic) header.license = lic[1];
      if (!header.title && /[|]/.test(L) && !/@/.test(L)) header.title = L;
      else if (!header.title && isAllCapsHeading(L) && L.length > 8) header.title = L;
      else if (!header.city) {
        var city = L.match(/([A-Z][A-Za-z .]+,\s*[A-Z]{2})\b/);
        if (city && !/@/.test(L)) header.city = city[1];
      }
    }
    // City may live on the contact line together with email/phone: re-scan that line.
    if (!header.city) {
      for (var k = 1; k < headerEnd; k++) {
        var cm = lines[k].match(/([A-Z][A-Za-z .]+,\s*[A-Z]{2})(?=\s*(?:•|$))/);
        if (cm) { header.city = cm[1]; break; }
      }
    }

    var sections = [];
    var references = [];
    var idx = firstHeadingIdx === -1 ? headerEnd : firstHeadingIdx;
    while (idx < lines.length) {
      var hLine = lines[idx];
      var known = knownHeading(hLine);
      var secKind, secTitle;
      if (known) { secKind = known.kind; secTitle = known.title; }
      else if (isAllCapsHeading(hLine)) { secKind = 'entries'; secTitle = hLine; }
      else { idx++; continue; }
      idx++;
      var body = [];
      while (idx < lines.length) {
        var nl = lines[idx];
        if (knownHeading(nl) || (isAllCapsHeading(nl) && secKind !== 'summary')) break;
        body.push(nl); idx++;
      }
      if (secKind === 'summary') {
        sections.push({ kind: 'summary', title: secTitle, headingChoice: secTitle, text: body.join(' ') });
      } else if (secKind === 'licenses') {
        var entries = [];
        body.forEach(function (b) {
          var t = b.replace(/^•\s*/, '').trim();
          if (!t) return;
          var m = t.match(STATUS_RE);
          if (m) entries.push({ heading: t.slice(0, m.index).trim(), right: m[0].trim(), line1: '', line2: '', bullets: [] });
          else entries.push({ heading: t, right: '', line1: '', line2: '', bullets: [] });
        });
        sections.push({ kind: 'entries', title: secTitle, bulletedEntries: true, entries: entries });
      } else if (secKind === 'experience' || secKind === 'education') {
        var ents = [];
        var bi = 0;
        function looksLikeNewEntry(at) {
          if (at >= body.length) return false;
          if (body[at].indexOf(' — ') === -1) return false;
          // Date range glued to the end of this heading line itself.
          if (DATE_RANGE_TAIL_RE.test(body[at])) return true;
          if (at + 1 < body.length && DATE_RANGE_RE.test(body[at + 1].replace(/^•\s*/, ''))) return true;
          if (at + 1 < body.length && /^Graduated:/i.test(body[at + 1])) return true;
          return false;
        }
        while (bi < body.length) {
          var hd = splitHeadingDate(body[bi].replace(/^•\s*/, ''));
          var cur = { heading: hd.heading, right: '', line1: hd.date || '', line2: '', bullets: [] };
          ents.push(cur);
          bi++;
          // "Graduated: ..." may ride on the end of the heading line itself.
          var gm = cur.heading.match(/^(.*?)\s+(Graduated:\s*.+)$/i);
          if (gm) { cur.heading = gm[1].trim(); cur.line1 = gm[2].trim(); }
          if (bi < body.length && !cur.line1 && DATE_RANGE_RE.test(body[bi])) { cur.line1 = body[bi]; bi++; }
          if (bi < body.length && /^Graduated:/i.test(body[bi])) { cur.line1 = body[bi]; bi++; }
          // Only experience entries have a sub-line (unit / rotation line);
          // education goes straight to bullets after "Graduated: ...".
          else if (secKind === 'experience' && bi < body.length && !/^•/.test(body[bi]) && !looksLikeNewEntry(bi)) { cur.line2 = body[bi]; bi++; }
          var sawMarker = false;
          while (bi < body.length) {
            var bl = body[bi];
            if (!/^•/.test(bl) && looksLikeNewEntry(bi)) break;
            if (/^•/.test(bl)) { sawMarker = true; cur.bullets.push(bl.replace(/^•\s*/, '')); bi++; }
            else if (sawMarker && cur.bullets.length) { cur.bullets[cur.bullets.length - 1] += ' ' + bl; bi++; }
            else { cur.bullets.push(bl); bi++; }
          }
        }
        var sec = { kind: 'entries', title: secTitle, entries: ents };
        if (secKind === 'education') sec.plainBullets = true;
        sections.push(sec);
      } else if (secKind === 'skills') {
        // Group "Category: ..." lines as separate bullet strings. Wrapped
        // lines (PDF) that do not start a new "Label:" continue the previous
        // bullet; if no line has a "Label:" shape, each line is its own bullet.
        var bullets = [];
        var hasCat = body.some(function (b) { return /^[A-Z][A-Za-z &\/-]+:/.test(b.replace(/^•\s*/, '')); });
        body.forEach(function (b) {
          var t = b.replace(/^•\s*/, '').trim();
          if (!t) return;
          if (hasCat && !/^[A-Z][A-Za-z &\/-]+:/.test(t) && bullets.length) bullets[bullets.length - 1] += ' ' + t;
          else bullets.push(t);
        });
        sections.push({ kind: 'bullets', title: secTitle, bullets: bullets });
      } else if (secKind === 'references') {
        var curRef = null;
        body.forEach(function (b) {
          var t = b.replace(/^•\s*/, '').trim();
          if (!t) return;
          if (/^Professional Relationship:/i.test(t)) return;
          var phm = t.match(/Phone:\s*([^•]+?)\s*(?:•\s*Email:\s*(.+))?$/i);
          if (phm && curRef) {
            curRef.phone = (phm[1] || '').trim();
            if (phm[2]) curRef.email = phm[2].split('•')[0].trim();
            return;
          }
          if (t.indexOf('|') !== -1 && curRef && !curRef.title) {
            var parts = t.split('|').map(function (x) { return x.trim(); });
            curRef.title = parts[0] || ''; curRef.facility = parts[1] || '';
            return;
          }
          if (!curRef || (curRef.phone && curRef.title)) {
            curRef = { name: t, title: '', facility: '', phone: '', email: '' };
            references.push(curRef);
          } else if (!curRef.title && t.indexOf('|') === -1) {
            curRef.name = t;
          }
        });
      } else {
        sections.push({ kind: 'entries', title: secTitle, entries: body.map(function (b) { return { heading: b, right: '', line1: '', line2: '', bullets: [] }; }) });
      }
    }

    if (!header.name && !sections.length) return null;
    var parsed = { header: header, sections: sections };
    if (references.length) parsed.references = references;
    return parsed;
  }

  /* ---------------- .docx extraction ---------------- */
  function base64ToBytes(b64) {
    var bin = atob(b64.replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function unzipEntries(bytes) {
    // Minimal ZIP reader using DecompressionStream (raw deflate entries).
    return (async function () {
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var entries = {};
      var off = 0;
      while (off + 30 <= bytes.length && view.getUint32(off, true) === 0x04034b50) {
        var flags = view.getUint16(off + 6, true);
        var method = view.getUint16(off + 8, true);
        var csize = view.getUint32(off + 18, true);
        var nlen = view.getUint16(off + 26, true);
        var elen = view.getUint16(off + 28, true);
        var name = new TextDecoder().decode(bytes.subarray(off + 30, off + 30 + nlen));
        var dataStart = off + 30 + nlen + elen;
        var comp = bytes.subarray(dataStart, dataStart + csize);
        var raw;
        if (method === 0) raw = comp;
        else if (method === 8) {
          var ds = new DecompressionStream('deflate-raw');
          raw = new Uint8Array(await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer());
        } else raw = new Uint8Array(0);
        entries[name] = raw;
        off = dataStart + csize;
        if (flags & 0x08) { /* data descriptor: not expected in docx; bail out of loop */ break; }
      }
      return entries;
    })();
  }

  function findMarker(entries) {
    var text = new TextDecoder().decode;
    for (var name in entries) {
      try {
        var s = new TextDecoder().decode(entries[name]);
        var i = s.indexOf('HIRESPARK_CV_B64:');
        if (i !== -1) {
          var rest = s.slice(i + 'HIRESPARK_CV_B64:'.length);
          var m = rest.match(/^[A-Za-z0-9+/=]+/);
          if (m) {
            var parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(m[0])));
            if (parsed && parsed.header) return parsed;
          }
        }
      } catch (e) { /* keep looking */ }
    }
    return null;
  }

  function docxXmlToText(xmlStr) {
    var doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    var lines = [];
    var paras = doc.getElementsByTagName('w:p');
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      var out = '';
      var nodes = p.getElementsByTagName('*');
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        var tag = n.tagName;
        if (tag === 'w:t' || tag === 't') out += n.textContent;
        else if (tag === 'w:tab' || tag === 'tab') out += '\t';
        else if (tag === 'w:br' || tag === 'br' || tag === 'w:cr') out += '\n';
      }
      lines.push(out);
    }
    return lines.join('\n');
  }

  async function extractDocxText(bytes) {
    var entries = await unzipEntries(bytes);
    var marker = findMarker(entries);
    if (marker) return { parsed: marker };
    var text = null;
    if (window.mammoth && window.mammoth.extractRawText) {
      try {
        var res = await window.mammoth.extractRawText({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
        text = res.value || '';
      } catch (e) { text = null; }
    }
    if (!text && entries['word/document.xml']) {
      text = docxXmlToText(new TextDecoder().decode(entries['word/document.xml']));
    }
    if (!text) throw new Error('Could not read this Word file. Please try a PDF or text file instead.');
    return { text: text };
  }

  /* ---------------- .pdf extraction ---------------- */
  async function extractPdfText(bytes) {
    if (!window.pdfjsLib) throw new Error('PDF reading is unavailable in this copy. Please upload a Word or text file instead.');
    var pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    var pages = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      var rows = {};
      tc.items.forEach(function (it) {
        var y = Math.round(it.transform[5]);
        (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str });
      });
      var lines = Object.keys(rows).map(Number).sort(function (a, b) { return b - a; }).map(function (y) {
        return rows[y].sort(function (a, b) { return a.x - b.x; }).map(function (o) { return o.s; }).join(' ');
      });
      pages.push(lines.join('\n'));
    }
    return pages.join('\n');
  }

  /* ---------------- image OCR (lazy CDN) ---------------- */
  var tesseractPromise = null;
  function ensureTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (!tesseractPromise) {
      tesseractPromise = loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js')
        .then(function () { if (!window.Tesseract) throw new Error('OCR library did not load.'); });
    }
    return tesseractPromise;
  }

  async function extractImageText(bytes, mimeType) {
    await ensureTesseract();
    var blob = new Blob([bytes], { type: mimeType || 'image/png' });
    var result = await window.Tesseract.recognize(blob, 'eng');
    return (result && result.data && result.data.text) || '';
  }

  /* ---------------- local parse-resume ---------------- */
  async function localParseResume(bodyObj) {
    var filename = (bodyObj && bodyObj.filename) || 'file';
    var mimeType = (bodyObj && bodyObj.mimeType) || '';
    var b64 = (bodyObj && bodyObj.dataBase64) || '';
    var ext = filename.split('.').pop().toLowerCase();
    if (!b64) return { parsed: null, error: 'No file data was received. Please try uploading the file again.' };
    var bytes;
    try { bytes = base64ToBytes(b64); } catch (e) { return { parsed: null, error: 'The uploaded file could not be read. Please try again.' }; }
    try {
      var text = null;
      if (ext === 'txt' || ext === 'md' || /text|markdown/.test(mimeType)) {
        text = new TextDecoder().decode(bytes);
      } else if (ext === 'docx' || /wordprocessingml|officedocument/.test(mimeType)) {
        var docx = await extractDocxText(bytes);
        if (docx.parsed) return { parsed: docx.parsed };
        text = docx.text;
      } else if (ext === 'pdf' || mimeType === 'application/pdf') {
        text = await extractPdfText(bytes);
      } else if (['png', 'jpg', 'jpeg', 'webp'].indexOf(ext) !== -1 || /^image\//.test(mimeType)) {
        try { text = await extractImageText(bytes, mimeType); }
        catch (e) { return { parsed: null, error: 'Image upload needs an internet connection for text recognition — please upload a PDF, Word or text file instead.' }; }
      } else {
        return { parsed: null, error: 'This file type is not supported for import. Please upload a PDF, Word (.docx), text or image file.' };
      }
      if (!text || !text.trim()) return { parsed: null, error: 'No readable text was found in this file. Please upload a clearer copy.' };
      var parsed = parseTextToParsed(text);
      if (!parsed) return { parsed: null, error: 'No resume text or sections were found in this file.' };
      return { parsed: parsed };
    } catch (e) {
      return { parsed: null, error: (e && e.message) || 'Could not extract resume details from this file.' };
    }
  }

  /* ---------------- the fetch patch ---------------- */
  window.fetch = function (input, init) {
    var url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) { url = ''; }
    var isParse = /\/api\/parse-resume(?:[?#]|$)/.test(url);
    var isJobs = /\/api\/jobs(?:[?#]|$)/.test(url);
    if (!isParse && !isJobs) return origFetch(input, init);

    return origFetch(input, init).then(function (resp) {
      var ct = '';
      try { ct = resp.headers.get('content-type') || ''; } catch (e) {}
      if (!resp.ok || ct.indexOf('application/json') === -1) return null;
      return resp.clone().json().then(function (data) {
        if (isParse && data && data.parsed) return resp;
        if (isJobs && data && Array.isArray(data.items)) return resp;
        return null;
      }).catch(function () { return null; });
    }).catch(function () { return null; }).then(function (goodResp) {
      if (goodResp) return goodResp;
      if (isJobs) return jsonResponse(JOBS_FALLBACK);
      // parse-resume fallback: read the request body
      var bodyPromise;
      if (init && typeof init.body === 'string') bodyPromise = Promise.resolve(init.body);
      else if (input && typeof input.clone === 'function') bodyPromise = input.clone().text().catch(function () { return ''; });
      else if (init && init.body) bodyPromise = Promise.resolve(typeof init.body === 'string' ? init.body : '');
      else bodyPromise = Promise.resolve('');
      return bodyPromise.then(function (bodyText) {
        var bodyObj = null;
        try { bodyObj = JSON.parse(bodyText || '{}'); } catch (e) { bodyObj = null; }
        return localParseResume(bodyObj).then(function (out) { return jsonResponse(out); });
      }).catch(function () { return jsonResponse({ parsed: null, error: 'Could not extract resume details from this file.' }); });
    });
  };
})();
