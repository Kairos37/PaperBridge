import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  lookupReferenceUrl,
  metadataToBibEntry,
  normalizeReferenceUrl,
  parseBibEntryText,
  searchReferenceTitles,
  suggestCitationKey
} from "../lib/reference-import.js";
import { startServer, stopServer } from "../server.js";

test("reference import resolves DOI metadata and creates the requested citation key shape", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /api\.crossref\.org\/works\/10\.1000%2Fxyz/);
    return new Response(JSON.stringify({
      message: {
        type: "journal-article",
        title: ["A survey on technologies, standards and open challenges in satellite IoT"],
        author: [
          { family: "Centenaro", given: "Marco" },
          { family: "Costa", given: "Cristina E" }
        ],
        "container-title": ["IEEE Communications Surveys & Tutorials"],
        volume: "23",
        issue: "3",
        page: "1693-1720",
        issued: { "date-parts": [[2021]] },
        publisher: "IEEE",
        DOI: "10.1000/xyz"
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const metadata = await lookupReferenceUrl("https://doi.org/10.1000/xyz", { fetchImpl });
  const key = suggestCitationKey(metadata, []);
  assert.equal(key, "centenaro2021survey");
  const entry = metadataToBibEntry(metadata, key);
  assert.match(entry.raw, /@article\{centenaro2021survey,/);
  assert.match(entry.raw, /pages=\{1693--1720\}/);
  assert.match(entry.raw, /journal=\{IEEE Communications Surveys \\& Tutorials\}/);
  assert.deepEqual(parseBibEntryText(entry.raw).key, key);
});

test("reference import falls back to citation meta tags for publisher pages", async () => {
  const html = [
    '<html><head>',
    '<meta name="citation_title" content="Fast Satellite Networks">',
    '<meta name="citation_author" content="Doe, Jane">',
    '<meta name="citation_journal_title" content="Journal of Networks">',
    '<meta name="citation_publication_date" content="2024-05-01">',
    '<meta name="citation_doi" content="10.1234/fast">',
    '</head></html>'
  ].join("");
  const fetchImpl = async (url) => {
    assert.equal(url, "https://publisher.example/paper");
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
  const metadata = await lookupReferenceUrl("https://publisher.example/paper", { fetchImpl });
  assert.equal(metadata.title, "Fast Satellite Networks");
  assert.equal(metadata.doi, "10.1234/fast");
  assert.equal(metadata.year, "2024");
  assert.notEqual(suggestCitationKey(metadata, ["doe2024fast"]), "doe2024fast");
});

test("arXiv pages become preprint misc entries instead of journal articles", async () => {
  assert.equal(normalizeReferenceUrl("arXiv:2401.12345v2").url, "https://arxiv.org/abs/2401.12345v2");
  const html = [
    "<html><head>",
    '<meta name="citation_title" content="Learning Reliable Satellite Links">',
    '<meta name="citation_author" content="Doe, Jane">',
    '<meta name="citation_arxiv_id" content="2401.12345">',
    '<meta name="citation_date" content="2024-01-20">',
    '<meta name="arxiv_primary_category" content="cs.NI">',
    "</head></html>"
  ].join("");
  const metadata = await lookupReferenceUrl("https://arxiv.org/abs/2401.12345", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://arxiv.org/abs/2401.12345");
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
  });
  const entry = metadataToBibEntry(metadata, "doe2024learning");
  assert.equal(metadata.type, "preprint");
  assert.match(entry.raw, /@misc\{doe2024learning,/);
  assert.match(entry.raw, /eprint=\{2401\.12345\}/);
  assert.match(entry.raw, /archivePrefix=\{arXiv\}/);
  assert.match(entry.raw, /primaryClass=\{cs\.NI\}/);
  assert.doesNotMatch(entry.raw, /journal=\{/);
});

test("ordinary pages become URL misc entries with an access date", async () => {
  const html = [
    "<html><head><title>Project Documentation</title>",
    '<meta property="og:site_name" content="Example Lab">',
    '<meta name="author" content="Example Lab">',
    "</head></html>"
  ].join("");
  const metadata = await lookupReferenceUrl("https://example.org/docs/project", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://example.org/docs/project");
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
  });
  const entry = metadataToBibEntry(metadata, "example2026project");
  assert.equal(metadata.type, "webpage");
  assert.match(entry.raw, /@misc\{example2026project,/);
  assert.match(entry.raw, /url=\{https:\/\/example\.org\/docs\/project\}/);
  assert.match(entry.raw, /note=\{Accessed: \d{4}-\d{2}-\d{2}\}/);
});

test("IEEE pages can resolve a missing DOI through a high-confidence Crossref title match", async () => {
  const pageUrl = "https://ieeexplore.ieee.org/document/1234567";
  const html = [
    "<html><head>",
    '<meta name="citation_title" content="Reliable Satellite IoT Routing">',
    '<meta name="citation_author" content="Doe, Jane">',
    '<meta name="citation_conference_title" content="IEEE INFOCOM">',
    '<meta name="citation_publication_date" content="2025-05-01">',
    "</head></html>"
  ].join("");
  const metadata = await lookupReferenceUrl(pageUrl, {
    fetchImpl: async (url) => {
      if (url === pageUrl) return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      assert.match(url, /api\.crossref\.org\/works\?query\.bibliographic=Reliable\+Satellite\+IoT\+Routing/);
      return new Response(JSON.stringify({
        message: {
          items: [{
            type: "proceedings-article",
            title: ["Reliable Satellite IoT Routing"],
            author: [{ family: "Doe", given: "Jane" }],
            "container-title": ["IEEE INFOCOM"],
            issued: { "date-parts": [[2025]] },
            DOI: "10.1109/INFOCOM12345.2025.1234567"
          }]
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const entry = metadataToBibEntry(metadata, "doe2025reliable");
  assert.equal(metadata.doi, "10.1109/INFOCOM12345.2025.1234567");
  assert.equal(metadata.doiDiscovery, "title-match");
  assert.match(entry.raw, /@inproceedings\{doe2025reliable,/);
  assert.match(entry.raw, /doi=\{10\.1109\/INFOCOM12345\.2025\.1234567\}/);
});

test("IEEE document, abstract, stamp and legacy links resolve to the same article", () => {
  for (const input of [
    "https://ieeexplore.ieee.org/document/9919149/",
    "https://ieeexplore.ieee.org/abstract/document/9919149?foo=bar#citations",
    "ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=9919149",
    "http://ieeexplore.ieee.org/xpl/articleDetails.jsp?arnumber=9919149",
    "https://ieeexplore.ieee.org/ielx7/6287639/6514899/09919149.pdf?arnumber=9919149"
  ]) {
    assert.equal(normalizeReferenceUrl(input).url, "https://ieeexplore.ieee.org/document/9919149");
  }
  assert.equal(normalizeReferenceUrl("https://ieeexplore.ieee.org.example.com/document/9919149").url,
    "https://ieeexplore.ieee.org.example.com/document/9919149");
});

test("IEEE embedded article metadata supplies DOI and author names without using cited DOIs", async () => {
  const pageUrl = "https://ieeexplore.ieee.org/document/9919149";
  const data = {
    articleNumber: "9919149",
    title: 'Reliable {Satellite} Links: A "Practical" Study',
    authors: [{ firstName: "Jane", lastName: "de Vries", affiliation: [{ name: "Example Lab" }] }],
    contentType: "Journals",
    publicationTitle: "IEEE Access",
    publicationYear: "2022",
    volume: "10", startPage: "100", endPage: "110",
    doi: "10.1109/ACCESS.2022.3214663"
  };
  const html = '<html><head><title>IEEE Xplore</title></head><body>'
    + '<a href="https://doi.org/10.1000/unrelated">Cited work</a>'
    + '<script>var xplGlobal = {}; xplGlobal.document.metadata = '
    + JSON.stringify(data) + '; window.afterMetadata = true;</script></body></html>';
  const metadata = await lookupReferenceUrl(pageUrl, {
    fetchImpl: async (url) => {
      if (url === pageUrl) return new Response(html);
      assert.equal(url, "https://api.crossref.org/works/10.1109%2FACCESS.2022.3214663");
      return new Response("Unavailable", { status: 503 });
    }
  });
  assert.equal(metadata.title, data.title);
  assert.equal(metadata.doi, data.doi);
  assert.deepEqual(metadata.authors, [{ given: "Jane", family: "de Vries", literal: "" }]);
  const entry = metadataToBibEntry(metadata, suggestCitationKey(metadata));
  assert.equal(entry.type, "article");
  assert.equal(entry.fields.journal, "IEEE Access");
  assert.equal(entry.fields.pages, "100--110");
  assert.equal(entry.fields.year, "2022");
});

test("IEEE citation export resolves a stamp link when its article page is blocked or offline", async (t) => {
  for (const failure of ["forbidden", "offline", "verification"]) {
    await t.test(failure, async () => {
      const metadata = await lookupReferenceUrl("https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=9919149", {
        fetchImpl: async (input, options) => {
          const url = new URL(input);
          if (url.pathname === "/document/9919149") {
            if (failure === "offline") throw new Error("Network unavailable");
            if (failure === "verification") return new Response('<title></title><script>window.gokuProps = {};</script>', { status: 202 });
            return new Response("Access denied", { status: 403 });
          }
          assert.equal(url.pathname, "/rest/search/citation/format");
          assert.equal(url.searchParams.get("recordIds"), "9919149");
          assert.equal(url.searchParams.get("download-format"), "download-bibtex");
          assert.equal(options.headers.Referer, "https://ieeexplore.ieee.org/document/9919149");
          return Response.json({ data: "@INPROCEEDINGS{9919149, title={Reliable Links &amp; Routing}, author={Doe, Jane and Wang, Wei}, booktitle={IEEE INFOCOM}, year={2025}, pages={1-10}, doi={10.1109/INFOCOM.2025.1234567}}" });
        }
      });
      assert.equal(metadata.doi, "10.1109/INFOCOM.2025.1234567");
      assert.equal(metadata.doiDiscovery, "ieee-citation");
      assert.equal(metadata.title, "Reliable Links & Routing");
      assert.equal(metadata.authors.length, 2);
      const entry = metadataToBibEntry(metadata, suggestCitationKey(metadata));
      assert.equal(entry.key, "doe2025reliable");
      assert.equal(entry.type, "inproceedings");
      assert.equal(entry.fields.booktitle, "IEEE INFOCOM");
      assert.equal(entry.fields.pages, "1--10");
    });
  }
});

test("IEEE metadata remains usable without a DOI when the citation service is unavailable", async () => {
  const metadata = await lookupReferenceUrl("https://ieeexplore.ieee.org/document/7654321", {
    fetchImpl: async (url) => {
      if (url === "https://ieeexplore.ieee.org/document/7654321") {
        return new Response('<script>xplGlobal.document.metadata = '
          + JSON.stringify({ articleNumber: "7654321", title: "Satellite Network Scheduling", contentType: "Conferences", publicationTitle: "IEEE INFOCOM", publicationYear: "2025", authors: [{ name: "Jane Doe" }] }) + ';</script>');
      }
      return new Response("Unavailable", { status: 503 });
    }
  });
  const entry = metadataToBibEntry(metadata, suggestCitationKey(metadata));
  assert.equal(entry.type, "inproceedings");
  assert.equal(entry.fields.author, "Doe, Jane");
  assert.equal(entry.fields.url, "https://ieeexplore.ieee.org/document/7654321");
  assert.equal(entry.fields.doi, undefined);
});

test("IEEE verification pages never become bogus bibliography entries", async (t) => {
  for (const title of ["", "IEEE Xplore", "IEEE Xplore - System Error", "Access Denied"]) {
    await t.test(title || "empty challenge title", async () => {
      await assert.rejects(lookupReferenceUrl("https://ieeexplore.ieee.org/document/9919149", {
        fetchImpl: async (url) => {
          if (url.includes("/rest/search/citation/format")) return new Response("Blocked", { status: 418 });
          assert.equal(url, "https://ieeexplore.ieee.org/document/9919149");
          return new Response("<title>" + title + "</title>", { status: 202 });
        }
      }), /IEEE.*访问验证.*BibTeX/);
    });
  }
});

test("reference API appends an entry to Bib and wires an unreferenced Bib file into main TeX", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-reference-add-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "references.bib"), "", "utf8");
    const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    const request = async (url, options = {}) => {
      const response = await fetch(`${server.url}${url}`, { headers: { "Content-Type": "application/json" }, ...options });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = { type: "openai-compatible", baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test", jsonMode: true };
    await request("/api/setup", { method: "POST", body: JSON.stringify({ source: { mode: "local", localPath: projectRoot }, translation: provider, diagnosis: provider }) });
    const raw = "@article{centenaro2021survey,\n  title={A survey on satellite IoT},\n  author={Centenaro, Marco},\n  journal={IEEE Communications Surveys \\& Tutorials},\n  year={2021}\n}";
    const result = await request("/api/references/add", { method: "POST", body: JSON.stringify({ bibFile: "references.bib", raw, key: "centenaro2021survey" }) });
    assert.equal(result.entry.key, "centenaro2021survey");
    assert.match(await fs.readFile(path.join(projectRoot, "references.bib"), "utf8"), /@article\{centenaro2021survey/);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /\\bibliography\{references\}/);
  } finally {
    await stopServer();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("title search uses each selected provider and preserves publication metadata", async (t) => {
  const title = "Satellite Signal Scaling";
  const doi = "10.1109/fixture.2025.123";
  const cases = [
    {
      provider: "crossref", host: "api.crossref.org", query: "query.bibliographic",
      response: () => Response.json({ message: { items: [{
        title: [title], author: [{ given: "Jane", family: "Doe" }], issued: { "date-parts": [[2025]] },
        type: "proceedings-article", "container-title": ["IEEE INFOCOM"], DOI: doi
      }] } })
    },
    {
      provider: "dblp", host: "dblp.org", query: "q",
      response: () => Response.json({ result: { hits: { hit: [{ info: {
        title, authors: { author: { text: "Jane Doe" } }, year: "2025", type: "Conference and Workshop Papers",
        venue: "IEEE INFOCOM", doi
      } }] } } })
    },
    {
      provider: "semantic", host: "api.semanticscholar.org", query: "query",
      response: () => Response.json({ data: [{
        title, authors: [{ name: "Jane Doe" }], year: 2025, publicationTypes: ["Conference"],
        publicationVenue: { name: "IEEE INFOCOM" }, externalIds: { DOI: doi }
      }] })
    },
    {
      provider: "arxiv", host: "export.arxiv.org", query: "search_query",
      response: () => new Response("<feed><entry><id>http://arxiv.org/abs/2501.01234v1</id><title>" + title
        + "</title><author><name>Jane Doe</name></author><published>2025-01-01</published>"
        + "<summary>Signal scaling for satellite links.</summary><arxiv:doi>" + doi + "</arxiv:doi></entry></feed>")
    }
  ];
  for (const source of cases) {
    await t.test(source.provider, async () => {
      const [entry] = await searchReferenceTitles(title, source.provider, { fetchImpl: async (address) => {
        const url = new URL(address);
        assert.equal(url.hostname, source.host);
        assert.ok(url.searchParams.get(source.query)?.includes(title));
        return source.response();
      } });
      assert.equal(entry.title, title);
      assert.equal(entry.year, "2025");
      assert.equal(entry.authors[0].family, "Doe");
      assert.equal(entry.doi || entry.publishedDoi, doi);
      if (source.provider === "arxiv") {
        assert.equal(entry.type, "preprint");
        assert.equal(entry.eprint, "2501.01234v1");
      } else {
        assert.equal(entry.type, "proceedings-article");
        assert.equal(entry.containerTitle, "IEEE INFOCOM");
      }
    });
  }
});
