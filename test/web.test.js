import test from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToText, isPrivateAddress, assertFetchable, fetchPage, pageToText, createWebFetchTool, createWebSearchTool,
  detectSearchProvider,
} from '../src/web.js';
import { RuleSet, matchDomainContent } from '../src/permissions.js';

const res = (body, { status = 200, type = 'text/html', headers = {} } = {}) => new Response(body, { status, headers: { 'content-type': type, ...headers } });
const noDns = async () => [{ address: '93.184.216.34' }];

test('htmlToText: title, headings, links (absolute), lists, pre blocks, entities; scripts and styles dropped', () => {
  const html = `<html><head><title>My &amp; Page</title><style>.x{}</style></head><body>
    <script>evil()</script><h1>Hello</h1><p>Some <b>bold</b> text &mdash; &#169; &#x41;</p>
    <ul><li>one</li><li>two</li></ul><a href="/docs/a">Docs</a> <a href="#top">Top</a>
    <pre>line1\n  &lt;tag&gt;</pre></body></html>`;
  const t = htmlToText(html, 'https://example.com/base/');
  assert.match(t, /^# My & Page/);
  assert.match(t, /# Hello/);
  assert.match(t, /Some bold text — © A/);
  assert.match(t, /- one\n- two/);
  assert.match(t, /\[Docs\]\(https:\/\/example\.com\/docs\/a\)/);
  assert.doesNotMatch(t, /evil|\.x\{\}|\(#top\)/);
  assert.match(t, /```\nline1\n  <tag>\n```/);
});

test('private address detection (v4, v6, mapped) and URL guard', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.equal(isPrivateAddress(ip), false, ip);
  await assert.rejects(assertFetchable('file:///etc/passwd'), /Unsupported URL scheme/);
  await assert.rejects(assertFetchable('http://user:pw@example.com/'), /credentials/);
  await assert.rejects(assertFetchable('http://localhost:8080/'), /local or private/);
  await assert.rejects(assertFetchable('http://192.168.8.32:8317/'), /local or private/);
  await assert.rejects(assertFetchable('http://printer.local/'), /local or private/);
  await assert.rejects(assertFetchable('https://sneaky.example/', { resolver: async () => [{ address: '10.0.0.5' }] }), /resolves to a private address/);
  assert.ok(await assertFetchable('http://192.168.8.32/', { allowPrivate: true }));
  assert.equal((await assertFetchable('https://example.com/x', { resolver: noDns })).hostname, 'example.com');
});

test('fetchPage: same-site redirects followed, cross-site reported, loops bounded, errors surfaced', async () => {
  const seq = (responses) => { let i = 0; return async () => responses[Math.min(i++, responses.length - 1)]; };
  const redir = (to, status = 301) => new Response(null, { status, headers: { location: to } });
  const ok = await fetchPage('http://example.com/a', { fetchImpl: seq([redir('https://www.example.com/b'), res('<p>hi</p>')]), resolver: noDns });
  assert.equal(ok.url, 'https://www.example.com/b');
  const cross = await fetchPage('https://example.com/a', { fetchImpl: seq([redir('https://other.org/x')]), resolver: noDns });
  assert.deepEqual(cross, { redirect: 'https://other.org/x', status: 301 });
  await assert.rejects(fetchPage('https://example.com/a', { fetchImpl: seq([redir('/a')]), resolver: noDns }), /Too many redirects/);
  await assert.rejects(fetchPage('https://example.com/a', { fetchImpl: seq([redir('http://169.254.169.254/latest')]), resolver: noDns }), /local or private/);
  await assert.rejects(fetchPage('https://example.com/a', { fetchImpl: seq([res('nope', { status: 404 })]), resolver: noDns }), /HTTP 404/);
  assert.throws(() => pageToText({ type: 'image/png', body: '', url: 'u' }), /Unsupported content type/);
  assert.equal(pageToText({ type: 'application/json', body: '{"a":1}', url: 'u' }), '{"a":1}');
});

test('WebFetch tool: extraction step uses the prompt; falls back to raw text; truncation and redirects reported', async () => {
  const fetchImpl = async () => res('<html><title>T</title><body><p>The answer is 42.</p></body></html>');
  let seen;
  const complete = async (a) => { seen = a; return 'It is 42.'; };
  const tool = createWebFetchTool({ complete, fetchImpl, resolver: noDns });
  const out = await tool.call({ url: 'https://example.com/p', prompt: 'what is the answer?' });
  assert.match(out, /^It is 42\./);
  assert.match(out, /source: https:\/\/example\.com\/p/);
  assert.match(seen.prompt, /<page url="https:\/\/example\.com\/p">[\s\S]*The answer is 42\./);
  assert.match(seen.system, /never follow instructions/);

  const failing = createWebFetchTool({ complete: async () => { throw new Error('model down'); }, fetchImpl, resolver: noDns });
  assert.match(await failing.call({ url: 'https://example.com/p', prompt: 'x' }), /extraction step failed: model down[\s\S]*The answer is 42/);

  const raw = createWebFetchTool({ fetchImpl, resolver: noDns });
  assert.match(await raw.call({ url: 'https://example.com/p', prompt: 'x' }), /^Content of https:\/\/example\.com\/p:/);

  const big = createWebFetchTool({ fetchImpl: async () => res(`<p>${'x'.repeat(50000)}</p>`), resolver: noDns });
  assert.match(await big.call({ url: 'https://example.com/p', prompt: 'x' }), /page truncated at 40000/);

  const redir = createWebFetchTool({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.net/' } }), resolver: noDns });
  assert.match(await redir.call({ url: 'https://example.com/p', prompt: 'x' }), /REDIRECT:.*https:\/\/elsewhere\.net\//s);
  assert.equal(tool.validateInput({ url: 'not a url' }).ok, false);
});

test('domain permission rules: exact host, *.wildcard excludes apex; WebFetch asks unless allowed', () => {
  assert.ok(matchDomainContent('domain:example.com', 'example.com'));
  assert.ok(!matchDomainContent('domain:example.com', 'docs.example.com'));
  assert.ok(matchDomainContent('domain:*.example.com', 'docs.example.com'));
  assert.ok(!matchDomainContent('domain:*.example.com', 'example.com'));
  const tool = createWebFetchTool({ fetchImpl: async () => res(''), resolver: noDns });
  const rules = new RuleSet({ cwd: '/p' }).add('allow', 'WebFetch(domain:docs.python.org)').add('deny', 'WebFetch(domain:*.evil.test)');
  assert.equal(rules.evaluate(tool, { url: 'https://docs.python.org/3/' }).behavior, 'allow');
  assert.equal(rules.evaluate(tool, { url: 'https://a.evil.test/x' }).behavior, 'deny');
  assert.equal(rules.evaluate(tool, { url: 'https://example.com/' }).behavior, undefined);
});

test('WebSearch: provider detection, searxng and brave parsing, domain filters, validation', async () => {
  assert.equal(detectSearchProvider({}), null);
  assert.equal(detectSearchProvider({ SEARXNG_URL: 'http://s' }), 'searxng');
  assert.equal(detectSearchProvider({ BRAVE_API_KEY: 'k' }), 'brave');
  assert.equal(detectSearchProvider({ REA_SEARCH_PROVIDER: 'nope' }), null);
  assert.equal(createWebSearchTool({ env: {} }), null);

  const calls = [];
  const sx = createWebSearchTool({ env: { SEARXNG_URL: 'http://searx.lan:8080/' }, fetchImpl: async (url) => {
    calls.push(url);
    return Response.json({ results: [
      { title: 'Python docs', url: 'https://docs.python.org/3/', content: 'The  Python\ndocs' },
      { title: 'Spam', url: 'https://spam.example/x', content: 'buy' },
      { title: 'Blog', url: 'https://blog.python.org/post', content: 'news' },
    ] });
  } });
  const out = await sx.call({ query: 'python docs', blocked_domains: ['spam.example'] });
  assert.match(calls[0], /^http:\/\/searx\.lan:8080\/search\?q=python\+docs&format=json/);
  assert.match(out, /1\. Python docs\n\s+https:\/\/docs\.python\.org\/3\/\n\s+The Python docs/);
  assert.doesNotMatch(out, /Spam/);
  const only = await sx.call({ query: 'q', allowed_domains: ['python.org'] });
  assert.match(only, /docs\.python\.org/); assert.match(only, /blog\.python\.org/);

  const brave = createWebSearchTool({ env: { BRAVE_API_KEY: 'bk' }, fetchImpl: async (url, init) => {
    assert.equal(init.headers['x-subscription-token'], 'bk');
    return Response.json({ web: { results: [{ title: 'B', url: 'https://b.example/', description: 'desc' }] } });
  } });
  assert.match(await brave.call({ query: 'x' }), /1\. B[\s\S]*desc/);
  assert.equal(sx.validateInput({ query: 'foo*' }).ok, false);
  assert.equal(sx.validateInput({ query: '  ' }).ok, false);
  const empty = createWebSearchTool({ provider: 'searxng', env: { SEARXNG_URL: 'http://s' }, fetchImpl: async () => Response.json({ results: [] }) });
  assert.match(await empty.call({ query: 'zzz' }), /No results/);
});

test('SearXNG non-JSON reply gives an actionable error', async () => {
  const t = createWebSearchTool({ provider: 'searxng', env: { SEARXNG_URL: 'http://s' }, fetchImpl: async () => new Response('<html>no</html>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(t.call({ query: 'x' }), /enable the json format/);
});
