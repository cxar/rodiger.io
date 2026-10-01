'use strict';

// Issuer discovery and the per-(asset, chain) address registry. Pure functions
// over fetched JSON; sources.js does the fetching. The only seeds are the ones
// that define *who the issuer is* (ISSUER below); every asset, chain, address,
// peer and reference is derived from upstream data.
//
// Discovery is the union of independent tiers. Joins onto DefiLlama list
// entries use gecko_id, exact name or a contract address - never a symbol on
// its own (USDGO, Binance-Peg BUSD, PYUSD0 and spoofed Stellar PYUSDs share or
// resemble Paxos tickers). A symbol is only ever used to pick which DefiLlama
// details to download so that an address can confirm the join.

const ISSUER = {
  cgCategory: 'paxos-ecosystem',
  goldCategory: 'tokenized-gold',
  feesSlug: 'paxos-stablecoin-issuer',
  protocolSlug: 'paxos',
  docsIndex: 'https://docs.paxos.com/llms.txt',
};

const TIERS = [
  { id: 'coingecko:category', label: `CoinGecko category "${ISSUER.cgCategory}"`, active: true },
  { id: 'paxos-docs', label: 'Paxos docs mainnet address tables', active: true },
  { id: 'defillama:fees-label', label: `DefiLlama fee adapter "${ISSUER.feesSlug}" labels`, active: false },
  { id: 'defillama:protocol', label: `DefiLlama protocol graph "${ISSUER.protocolSlug}"`, active: false },
];
const ACTIVE_TIERS = new Set(TIERS.filter((t) => t.active).map((t) => t.id));

const lc = (s) => String(s == null ? '' : s).toLowerCase();
const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const normAddr = (a) => (isEvm(a) ? a.toLowerCase() : String(a || '').trim());
const okAddr = (a) => typeof a === 'string' && /^[A-Za-z0-9._-]{20,128}$/.test(a);
const symKey = (s) => lc(s).replace(/[^a-z0-9]/g, '');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const pegValue = (entry, peg = entry && entry.pegType) => (entry && entry.circulating && typeof entry.circulating === 'object' && num(entry.circulating[peg])) || 0;

// ---------- chain names ----------
// DefiLlama display names are canonical. Other spellings ("Xlayer", "x-layer",
// "Arbitrum Mainnet", "arbitrum-one", "polygon-pos", "Solana Mainnet Beta")
// are matched by a normalised key: lower-case alphanumerics with trailing
// qualifier words dropped, plus EVM chainId equality where both sides have one.
const SUFFIX_WORDS = new Set(['mainnet', 'beta', 'one', 'pos', 'chain', 'network']);
function chainKey(name) {
  const w = lc(name).split(/[^a-z0-9]+/).filter(Boolean);
  while (w.length > 1 && SUFFIX_WORDS.has(w[w.length - 1])) w.pop();
  return w.join('');
}

function makeChainNamer({ listChains = [], llamaChains = [], cgPlatforms = [], evmChains = null } = {}) {
  const canon = new Map(); // key -> display name
  const idOf = new Map(); // display -> EVM chainId
  const byChainId = new Map();
  const byGecko = new Map();
  const add = (name) => {
    if (typeof name !== 'string' || !name.trim()) return null;
    const k = chainKey(name);
    if (k && !canon.has(k)) canon.set(k, name.trim());
    return canon.get(k);
  };
  for (const c of listChains || []) add(c && c.name);
  for (const c of llamaChains || []) {
    const d = add(c && c.name);
    if (!d) continue;
    const id = Number(c.chainId);
    if (Number.isInteger(id) && id > 0) {
      if (!byChainId.has(id)) byChainId.set(id, d);
      if (!idOf.has(d)) idOf.set(d, id);
    }
    if (c.gecko_id && !byGecko.has(c.gecko_id)) byGecko.set(c.gecko_id, d);
  }
  const plats = new Map((Array.isArray(cgPlatforms) ? cgPlatforms : []).filter((p) => p && p.id).map((p) => [p.id, p]));
  const name = (raw) => {
    if (raw == null || raw === '') return null;
    return canon.get(chainKey(raw)) || String(raw).trim().replace(/\s+/g, ' ');
  };
  const fromCgPlatform = (id) => {
    const p = plats.get(id);
    const ci = p && Number(p.chain_identifier);
    if (ci && byChainId.has(ci)) return byChainId.get(ci);
    for (const cand of [id, p && p.name, p && p.shortname]) {
      const d = cand && canon.get(chainKey(cand));
      if (d) return d;
    }
    // Non-EVM platforms: the platform's native coin (or id) is the chain's gecko id.
    if (p && !ci) for (const g of [p.native_coin_id, id]) if (g && byGecko.has(g)) return byGecko.get(g);
    return (p && p.name) || id;
  };
  for (const p of plats.values()) {
    const ci = Number(p.chain_identifier);
    if (!Number.isInteger(ci) || ci <= 0) continue;
    const d = fromCgPlatform(p.id);
    if (canon.has(chainKey(d)) && !idOf.has(d)) idOf.set(d, ci);
  }
  // Last resort for an EVM chain id: the chainid.network registry, by normalised name ("X Layer Mainnet"
  // -> "xlayer"), only where exactly one registry chain has that name and the id is not already taken.
  if (evmChains && typeof evmChains === 'object') {
    const ids = new Map();
    for (const [id, c] of Object.entries(evmChains)) {
      const k = c && typeof c.name === 'string' ? chainKey(c.name) : '';
      if (k) ids.set(k, ids.has(k) ? null : Number(id));
    }
    const taken = new Set(idOf.values());
    for (const [k, d] of canon) {
      const id = ids.get(k);
      if (!idOf.has(d) && Number.isInteger(id) && id > 0 && !taken.has(id)) { idOf.set(d, id); taken.add(id); }
    }
  }
  return {
    name,
    fromCgPlatform,
    chainId: (display) => idOf.get(display) || null,
    isCanonical: (display) => canon.get(chainKey(display)) === display,
    key: chainKey,
  };
}

// Chain of a DefiLlama detail where the asset is minted (largest last minted balance).
function homeChain(d, namer) {
  let best = null;
  for (const [chain, cb] of Object.entries((d && d.chainBalances) || {})) {
    const last = cb && Array.isArray(cb.tokens) ? cb.tokens[cb.tokens.length - 1] : null;
    const m = last && last.minted && typeof last.minted === 'object' ? num(Object.values(last.minted)[0]) : null;
    if (m > 0 && (!best || m > best.m)) best = { chain, m };
  }
  return best ? namer.name(best.chain) : null;
}

// ---------- tier parsers ----------
function feeLabelNames(fees) {
  const names = new Set();
  const bm = fees && isObj(fees.breakdownMethodology) ? fees.breakdownMethodology : {};
  for (const group of Object.values(bm)) {
    for (const label of Object.keys(isObj(group) ? group : {})) {
      const m = label.match(/^Yields from (.+?) backing$/i);
      if (m) names.add(m[1].trim());
    }
  }
  return [...names];
}

function feeLabels(fees) {
  const bm = fees && isObj(fees.breakdownMethodology) ? fees.breakdownMethodology : {};
  return Object.keys(isObj(bm.Fees) ? bm.Fees : {});
}

function parseDocsIndex(text) {
  const re = /docs\.paxos\.com\/guides\/stablecoin\/([a-z0-9-]+)\/mainnet\.md/g;
  return [...new Set([...String(text || '').matchAll(re)].map((m) => m[1]))];
}

// Address tables of a docs mainnet page, recognised by their header row (a network column next to an
// address column), wherever they sit on the page and in whatever column order. The token-contract
// table is kept as rows; supply-control and OFT/bridge tables are kept apart (they are not token
// contracts, but they say on which chains the issuer itself controls supply). A table is classified
// by its address header, and by its section heading only when that header is generic ("Address",
// "Contract Address"). Addresses may be plain, backticked or link text.
const NON_TOKEN = /owner|admin|minter|burner|multisig|freeze|pause|proxy|implementation|treasury/i;
function tableCells(line) {
  const t = String(line || '').trim();
  if (!t.startsWith('|') || t.length < 3) return null;
  return t.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}
const isSeparator = (cs) => Boolean(cs && cs.length && cs.every((c) => /^:?-+:?$/.test(c)));
function addressIn(cell) {
  const link = String(cell || '').match(/^\[\s*([^\]]+?)\s*\]\([^)]*\)$/);
  const raw = (link ? link[1] : String(cell || '')).replace(/`/g, '').trim();
  return okAddr(raw) ? raw : null;
}
function tableKind(header, heading) {
  for (const label of [header, heading]) {
    if (/\boft\b|bridge|adapter/i.test(label)) return 'oft';
    if (/supply|control/i.test(label)) return 'supplyControl';
    if (/token/i.test(label)) return 'rows'; // e.g. "Token (proxy) address" is still the token
    if (NON_TOKEN.test(label)) return null;
  }
  return 'rows';
}
function parseDocsMainnet(md, slug) {
  const lines = String(md || '').split('\n');
  const out = { slug, symbol: null, rows: [], supplyControl: [], oft: [], tables: 0 };
  let symbol = null;
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const title = line.match(/^#\s+(\S+)/);
    if (title && !symbol && /^[A-Za-z0-9]{2,12}$/.test(title[1])) symbol = title[1].toUpperCase();
    const h = line.match(/^##+\s+(.*)/);
    if (h) {
      heading = h[1];
      continue;
    }
    const head = tableCells(line);
    if (!head || !isSeparator(tableCells(lines[i + 1]))) continue;
    const body = [];
    let j = i + 2;
    for (; j < lines.length && tableCells(lines[j]); j++) body.push(tableCells(lines[j]));
    i = j - 1;
    out.tables++;
    const net = head.findIndex((c) => /network|chain|blockchain/i.test(c));
    const adr = head.findIndex((c, k) => k !== net && /address|contract/i.test(c));
    if (net < 0 || adr < 0) continue;
    const kind = tableKind(head[adr], heading);
    if (!kind) continue;
    for (const r of body) {
      const address = addressIn(r[adr]);
      if (address && r[net] && !/^:?-+:?$/.test(r[net])) out[kind].push({ network: r[net], address });
    }
  }
  out.symbol = symbol || (slug ? slug.toUpperCase() : null);
  return out;
}

// ---------- discovery ----------
// core = { list, fees, protocols:[json], cgMarkets:[row]|null, cgDetails:{geckoId:json}, cgGold:[row]|null,
//          docs:{slug:{symbol,rows}}|null, llamaDetails:{id:json}, links:[{geckoId,chain,address}], namer, tierOk:{tierId:boolean} }
// links = contract <-> CoinGecko id pairs confirmed by coins.llama.fi (see coinLinks).
function discover(core) {
  const { list, fees, protocols = [], cgMarkets, cgDetails = {}, cgGold, docs, llamaDetails = {}, links = [], tierOk = {} } = core;
  const namer = core.namer || makeChainNamer({ listChains: list && list.chains });
  const errors = [];
  // One malformed upstream record drops that record (listed in errors), never the whole discovery.
  const guarded = (what, fn) => {
    try {
      fn();
    } catch (e) {
      errors.push(`discover ${what}: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  };
  const entries = (list && Array.isArray(list.peggedAssets) ? list.peggedAssets : []).filter((x) => isObj(x) && x.id != null);
  const byId = new Map(entries.map((x) => [String(x.id), x]));
  const byGecko = new Map();
  for (const x of entries) if (typeof x.gecko_id === 'string' && x.gecko_id) byGecko.set(x.gecko_id, byGecko.has(x.gecko_id) ? null : x); // null = ambiguous
  const byName = new Map();
  for (const x of entries) if (typeof x.name === 'string') byName.set(lc(x.name), byName.has(lc(x.name)) ? null : x);

  const items = [];
  const item = (o) => items.push({ tier: null, geckoId: null, llamaId: null, llamaVia: null, addrs: [], ...o });
  const llamaFor = (o) => {
    const g = o.geckoId && byGecko.get(o.geckoId);
    if (g) return { llamaId: String(g.id), llamaVia: 'gecko_id' };
    const n = o.name && byName.get(lc(o.name));
    if (n) return { llamaId: String(n.id), llamaVia: 'name' };
    return {};
  };

  for (const c of Array.isArray(cgMarkets) ? cgMarkets : []) {
    if (!isObj(c) || typeof c.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) continue;
    guarded(`coingecko ${c.id}`, () => {
      const det = isObj(cgDetails[c.id]) ? cgDetails[c.id] : null;
      const addrs = [];
      for (const [pid, d] of Object.entries(det && isObj(det.detail_platforms) ? det.detail_platforms : {})) {
        if (!isObj(d) || !okAddr(d.contract_address)) continue;
        addrs.push({ chain: namer.fromCgPlatform(pid), address: d.contract_address, decimals: num(d.decimal_place), cgPlatform: pid, via: 'coingecko' });
      }
      const categories = det && Array.isArray(det.categories) ? det.categories.filter((x) => typeof x === 'string') : null;
      const o = { tier: 'coingecko:category', geckoId: c.id, symbol: String(c.symbol || '').toUpperCase(), name: typeof c.name === 'string' ? c.name : null, cg: c, categories, addrs };
      item({ ...o, ...llamaFor(o) });
    });
  }

  for (const n of feeLabelNames(fees)) {
    const x = byName.get(lc(n));
    if (x) item({ tier: 'defillama:fees-label', llamaId: String(x.id), llamaVia: 'name', geckoId: typeof x.gecko_id === 'string' && x.gecko_id ? x.gecko_id : null, symbol: x.symbol, name: x.name, feeModelled: true });
  }

  // Protocol graph: children of the parent with a token address (e.g. a gold
  // token). The parent itself repeats a child's address, so it only counts
  // when it names an address no child has.
  const protos = (Array.isArray(protocols) ? protocols : []).filter((p) => isObj(p) && p.address && typeof p.symbol === 'string' && p.symbol !== '-');
  const childAddrs = new Set(protos.filter((p) => !p.isParentProtocol).map((p) => normAddr(String(p.address).split(':').pop())));
  for (const p of protos) {
    guarded(`protocol ${p.name}`, () => {
      const raw = String(p.address);
      const [pfx, addr] = raw.includes(':') ? raw.split(':') : [null, raw];
      if (!okAddr(addr) || (p.isParentProtocol && childAddrs.has(normAddr(addr)))) return;
      const chain = pfx ? namer.name(pfx) : typeof p.chain === 'string' ? namer.name(p.chain) : Array.isArray(p.chains) && p.chains.length === 1 ? namer.name(p.chains[0]) : null;
      const o = {
        tier: 'defillama:protocol',
        geckoId: typeof p.gecko_id === 'string' && /^[a-z0-9-]+$/.test(p.gecko_id) ? p.gecko_id : null,
        symbol: p.symbol,
        name: p.isParentProtocol || typeof p.name !== 'string' ? null : p.name,
        tags: [].concat(Array.isArray(p.tags) ? p.tags : [], typeof p.category === 'string' ? p.category : []).filter((t) => typeof t === 'string'),
        addrs: [{ chain, address: addr, via: 'defillama:protocol', kind: 'issued' }],
      };
      item({ ...o, ...llamaFor(o) });
    });
  }

  for (const [slug, page] of Object.entries(docs || {})) {
    if (!isObj(page) || !Array.isArray(page.rows) || !page.rows.length) continue;
    const ctl = (rows) => (Array.isArray(rows) ? rows : []).map((r) => ({ chain: namer.name(r.network), address: r.address }));
    item({
      tier: 'paxos-docs',
      symbol: page.symbol,
      docsSlug: slug,
      controls: { supplyControl: ctl(page.supplyControl), oft: ctl(page.oft) },
      addrs: page.rows.map((r) => ({ chain: namer.name(r.network), address: r.address, via: 'paxos-docs' })),
    });
  }

  // DefiLlama details are enrichment only: they join groups (by id or by a
  // shared contract address) but never create an asset on their own. The
  // chainConfig key says how DefiLlama counts each contract: "issued" or
  // "bridgedFrom<chain>" (a third-party bridged representation).
  for (const [id, d] of Object.entries(llamaDetails || {})) {
    if (!isObj(d) || !byId.has(String(id))) continue;
    guarded(`defillama detail ${id}`, () => {
      const addrs = [];
      if (typeof d.address === 'string') {
        const [pfx, a] = d.address.includes(':') ? d.address.split(':') : [null, d.address];
        // A bare (unprefixed) address joins on the address alone; if no source
        // names its chain, it is placed on the asset's home chain (largest minted balance).
        if (okAddr(a)) addrs.push({ chain: pfx ? namer.name(pfx) : null, homeChain: pfx ? null : homeChain(d, namer), address: a, via: 'defillama', kind: 'listed' });
      }
      const chains = d.chainConfig && isObj(d.chainConfig.chains) ? d.chainConfig.chains : {};
      for (const [key, kinds] of Object.entries(chains)) {
        for (const [kind, arr] of Object.entries(isObj(kinds) ? kinds : {})) {
          for (const a of Array.isArray(arr) ? arr : []) if (okAddr(a)) addrs.push({ chain: namer.name(key), address: a, llamaKey: key, via: 'defillama', kind });
        }
      }
      item({ llamaId: String(id), llamaVia: 'address', addrs });
    });
  }

  for (const l of Array.isArray(links) ? links : []) if (isObj(l) && okAddr(l.address)) item({ geckoId: l.geckoId, addrs: [{ chain: l.chain, address: l.address, via: null }] });

  // Union-find over items. Same gecko id or same llama id always merge; a
  // shared (chain, address) merges unless that would put two different
  // DefiLlama or CoinGecko ids into one asset.
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ids = items.map((it) => ({ g: new Set(it.geckoId ? [it.geckoId] : []), l: new Set(it.llamaId ? [it.llamaId] : []) }));
  const union = (a, b, guardedUnion) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const A = ids[ra], B = ids[rb];
    if (guardedUnion) {
      const g = new Set([...A.g, ...B.g]), l = new Set([...A.l, ...B.l]);
      if (g.size > 1 || l.size > 1) return;
    }
    parent[rb] = ra;
    for (const x of B.g) A.g.add(x);
    for (const x of B.l) A.l.add(x);
  };
  const firstBy = new Map();
  items.forEach((it, i) => {
    for (const k of [it.geckoId && 'g:' + it.geckoId, it.llamaId && 'l:' + it.llamaId].filter(Boolean)) {
      if (firstBy.has(k)) union(firstBy.get(k), i, false);
      else firstBy.set(k, i);
    }
  });
  const addrOwners = new Map(); // normAddr -> [{ i, chainKey }]
  items.forEach((it, i) => {
    for (const a of it.addrs) {
      const k = normAddr(a.address);
      const ck = a.chain ? chainKey(a.chain) : null;
      for (const o of addrOwners.get(k) || []) if (!o.ck || !ck || o.ck === ck) union(o.i, i, true);
      if (!addrOwners.has(k)) addrOwners.set(k, []);
      addrOwners.get(k).push({ i, ck });
    }
  });

  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });

  const anyActiveTierOk = [...ACTIVE_TIERS].some((t) => tierOk[t]);
  const goldIds = new Set((Array.isArray(cgGold) ? cgGold : []).map((c) => isObj(c) && c.id).filter(Boolean));
  const assets = [];
  const pending = [];
  for (const g of groups.values()) guarded(`group ${g.map((it) => it.geckoId || it.llamaId || it.docsSlug).filter(Boolean)[0] || '?'}`, () => {
    const tiers = TIERS.map((t) => t.id).filter((t) => g.some((it) => it.tier === t));
    if (!tiers.length) return; // details-only group: an unconfirmed candidate
    const pick = (f) => g.map(f).find((v) => v != null && v !== '');
    const llamaId = pick((it) => it.llamaId) || null;
    const entry = llamaId ? byId.get(llamaId) || null : null;
    const cgItem = g.find((it) => it.tier === 'coingecko:category');
    const geckoId = pick((it) => it.geckoId) || (entry && typeof entry.gecko_id === 'string' && entry.gecko_id) || null;
    const llamaVia = llamaId ? (g.find((it) => it.llamaId === llamaId && it.tier) || g.find((it) => it.llamaId === llamaId)).llamaVia : null;
    const docsItem = g.find((it) => it.tier === 'paxos-docs');
    const protoItem = g.find((it) => it.tier === 'defillama:protocol');
    const str = (x) => (typeof x === 'string' && x ? x : null);
    const symbol = (cgItem && str(cgItem.symbol)) || (entry && str(entry.symbol)) || pick((it) => it.tier && str(it.symbol)) || null;
    const name = (cgItem && str(cgItem.name)) || (entry && str(entry.name)) || pick((it) => it.tier && str(it.name)) || symbol;
    const categories = cgItem && cgItem.categories ? cgItem.categories : null;
    const tags = protoItem ? protoItem.tags : [];
    const pegType = entry && typeof entry.pegType === 'string' ? entry.pegType : null;
    const isGold =
      (categories || []).some((c) => /gold/i.test(c)) || (geckoId && goldIds.has(geckoId)) || (tags.some((t) => /commodit/i.test(t)) && /gold/i.test(name || ''));
    const kind = isGold
      ? 'gold'
      : pegType === 'peggedUSD' || (!pegType && (categories || []).some((c) => /\busd stablecoin\b/i.test(c)))
        ? 'usd-stablecoin'
        : (pegType && /^pegged[A-Z]{3}$/.test(pegType) && pegType !== 'peggedVAR') || (!pegType && (categories || []).some((c) => /stablecoin/i.test(c)))
          ? 'fiat-stablecoin'
          : 'other';
    let status;
    if (entry && entry.deadFrom) status = 'dead';
    else if (tiers.some((t) => ACTIVE_TIERS.has(t))) status = 'active';
    // No active-issuance tier answered: unknown must not hide an asset, so it
    // stays active unless its list supply has been frozen for the past month.
    else if (!anyActiveTierOk && (!entry || pegValue(entry) !== pegValue({ circulating: entry.circulatingPrevMonth }, entry.pegType))) status = 'active';
    else status = 'legacy';

    // Addresses: merge on (chain, address); chain-less entries fold into a
    // chained twin or are dropped.
    const addrMap = new Map();
    const chainless = [];
    const blank = (chain, address) => ({ chain, address, decimals: null, chainId: namer.chainId(chain), llamaKey: null, cgPlatform: null, via: [], kinds: new Set() });
    for (const it of g) {
      for (const a of it.addrs) {
        if (!a.chain) { chainless.push(a); continue; }
        const k = chainKey(a.chain) + '|' + normAddr(a.address);
        const cur = addrMap.get(k) || blank(a.chain, a.address);
        if (a.via === 'paxos-docs') cur.address = a.address; // keep the issuer's checksummed spelling
        if (cur.decimals == null && a.decimals != null) cur.decimals = a.decimals;
        if (!cur.llamaKey && a.llamaKey) cur.llamaKey = a.llamaKey;
        if (!cur.cgPlatform && a.cgPlatform) cur.cgPlatform = a.cgPlatform;
        if (a.via && !cur.via.includes(a.via)) cur.via.push(a.via);
        if (a.kind) cur.kinds.add(a.kind);
        if (cur.via.length) addrMap.set(k, cur);
      }
    }
    for (const a of chainless) {
      const twins = [...addrMap.values()].filter((cur) => normAddr(cur.address) === normAddr(a.address));
      for (const cur of twins) {
        if (a.via && !cur.via.includes(a.via)) cur.via.push(a.via);
        if (a.kind) cur.kinds.add(a.kind);
      }
      if (!twins.length && a.homeChain && a.via) {
        const cur = blank(a.homeChain, a.address);
        cur.via.push(a.via);
        if (a.kind) cur.kinds.add(a.kind);
        addrMap.set(chainKey(a.homeChain) + '|' + normAddr(a.address), cur);
      }
    }
    // Role of each contract. issuer: listed in the issuer's docs, counted as "issued" by DefiLlama,
    // or the protocol graph's token; bridged: DefiLlama counts it only as bridged from another chain
    // (a third-party representation, e.g. a bridge's pegged token); unlisted: only an aggregator lists
    // it while the issuer's own address table (fetched for this asset) does not; unverified: no
    // issuer table to check against. Bridged and unlisted contracts are kept apart
    // (thirdPartyAddresses) so pool matching, on-chain supply and price lookups use issuer contracts only.
    const hasDocs = Boolean(docsItem);
    const all = [...addrMap.values()].map((cur) => {
      const issued = cur.via.includes('paxos-docs') || cur.kinds.has('issued');
      const bridged = [...cur.kinds].some((k) => /^bridged/i.test(k));
      const role = issued ? 'issuer' : bridged ? 'bridged' : hasDocs ? 'unlisted' : 'unverified';
      const { kinds, ...rest } = cur;
      return { ...rest, role };
    }).sort((x, y) => x.chain.localeCompare(y.chain) || x.address.localeCompare(y.address));
    const addresses = all.filter((x) => x.role === 'issuer' || x.role === 'unverified');
    const thirdPartyAddresses = all.filter((x) => x.role === 'bridged' || x.role === 'unlisted');

    const asset = {
      symbol,
      name,
      geckoId,
      llamaId,
      via: tiers,
      kind,
      status,
      pegType,
      pegMechanism: entry && typeof entry.pegMechanism === 'string' ? entry.pegMechanism : null,
      dead: entry && entry.deadFrom ? entry.deadFrom : null,
      feeModelled: g.some((it) => it.feeModelled),
      list: entry,
      cg: cgItem ? cgItem.cg : null,
      categories,
      docsSlug: docsItem ? docsItem.docsSlug : null,
      controls: docsItem ? docsItem.controls : null,
      joins: { llama: llamaVia, gecko: cgItem ? 'coingecko:category' : geckoId ? (entry && entry.gecko_id === geckoId ? 'defillama:list' : 'defillama:protocol') : null },
      addresses,
      thirdPartyAddresses,
    };
    assets.push(asset);
    if (!llamaId && !geckoId && docsItem) {
      // Unconfirmed docs asset: candidate list entries share its ticker; their
      // details are fetched so an address can confirm (or reject) the join.
      const cands = entries
        .filter((x) => !x.deadFrom && symKey(x.symbol) === symKey(docsItem.symbol))
        .sort((x, y) => pegValue(y) - pegValue(x))
        .slice(0, 3)
        .map((x) => String(x.id));
      if (cands.length) pending.push({ slug: docsItem.docsSlug, symbol: docsItem.symbol, candidates: cands });
    }
  });

  // Display keys: upper-case symbol, disambiguated by name when two collide.
  const count = new Map();
  for (const a of assets) count.set(lc(a.symbol), (count.get(lc(a.symbol)) || 0) + 1);
  for (const a of assets) a.key = count.get(lc(a.symbol)) > 1 ? `${String(a.symbol || '').toUpperCase()} (${a.name})` : String(a.symbol || a.name || '').toUpperCase();
  const rank = { active: 0, legacy: 1, dead: 2 };
  const mcap = (a) => (a.cg && num(a.cg.market_cap)) || 0;
  assets.sort((x, y) => rank[x.status] - rank[y.status] || pegValue(y.list) - pegValue(x.list) || mcap(y) - mcap(x) || x.key.localeCompare(y.key));

  const tiers = TIERS.map((t) => ({ id: t.id, label: t.label, ok: Boolean(tierOk[t.id]), found: assets.filter((a) => a.via.includes(t.id)).map((a) => a.key) }));
  return { assets, tiers, pending, errors };
}

// ---------- peers and references ----------
// Peg peers: the smallest set of the largest live assets with the same peg
// type and mechanism as the live Paxos USD stablecoins that together hold at
// least half of that segment (computed, not named). Paxos assets and list
// entries flagged by listSanity are left out.
function selectPegPeers(list, assets, excludedIds = new Set()) {
  const live = assets.filter((a) => a.kind === 'usd-stablecoin' && a.status !== 'dead' && a.list);
  const w = new Map();
  for (const a of live) {
    const k = a.list.pegType + '|' + a.list.pegMechanism;
    w.set(k, (w.get(k) || 0) + pegValue(a.list));
  }
  const seg = [...w.entries()].sort((x, y) => y[1] - x[1])[0];
  if (!seg) return [];
  const [pegType, pegMechanism] = seg[0].split('|');
  const pax = new Set(assets.map((a) => a.llamaId).filter(Boolean));
  const pool = ((list && list.peggedAssets) || [])
    .filter((x) => x.pegType === pegType && x.pegMechanism === pegMechanism && !x.deadFrom && !pax.has(String(x.id)) && !excludedIds.has(String(x.id)) && pegValue(x) > 0)
    .sort((x, y) => pegValue(y) - pegValue(x));
  // The peg reference is a per-day median over these peers: at least three (the smallest set whose
  // median ignores one bad print), taken by size beyond the half-coverage set when it is smaller.
  const sel = coverHalf(pool, pegValue);
  const total = pool.reduce((sum, x) => sum + pegValue(x), 0);
  for (const x of pool.slice(sel.length, 3)) sel.push({ x, share: pegValue(x) / total });
  return sel.map(({ x, share }) => ({ symbol: x.symbol, geckoId: x.gecko_id || null, llamaId: String(x.id), share }));
}

// Gold references: the largest non-Paxos members of the tokenized-gold
// category, covering half of that segment. Members quoted per gram (or any
// other unit) are left out: a same-unit quote is within half a decade of the
// Paxos gold asset's price, a per-gram one is ~31x (1.5 decades) lower.
function selectGoldRefs(cgGold, assets) {
  const rows = (Array.isArray(cgGold) ? cgGold : []).filter((c) => c && typeof c.id === 'string' && /^[a-z0-9-]+$/.test(c.id));
  const inCat = new Set(rows.map((c) => c.id));
  const gold = assets.filter((a) => a.status !== 'dead' && (a.kind === 'gold' || (a.geckoId && inCat.has(a.geckoId))));
  const px = gold.map((a) => (a.cg && num(a.cg.current_price)) || num((rows.find((c) => c.id === a.geckoId) || {}).current_price)).filter((p) => p > 0);
  if (!px.length) return [];
  px.sort((a, b) => a - b);
  const p0 = px[Math.floor(px.length / 2)];
  const pax = new Set(assets.map((a) => a.geckoId).filter(Boolean));
  const pool = rows
    .filter((c) => !pax.has(c.id) && num(c.market_cap) > 0 && num(c.current_price) > 0 && Math.abs(Math.log10(c.current_price / p0)) < 0.5)
    .sort((x, y) => y.market_cap - x.market_cap);
  return coverHalf(pool, (c) => c.market_cap).map(({ x }) => ({ symbol: String(x.symbol || '').toUpperCase(), geckoId: x.id, name: x.name }));
}

function coverHalf(sorted, val) {
  const total = sorted.reduce((s, x) => s + val(x), 0);
  const out = [];
  let cum = 0;
  for (const x of sorted) {
    if (cum >= total / 2) break;
    out.push({ x, share: val(x) / total });
    cum += val(x);
  }
  return out;
}

// coins.llama.fi prices a contract with exactly the price record of the
// CoinGecko id it maps the contract to (same float, same timestamp). When a
// CoinGecko category row has no contract list yet (coin details not fetched)
// and a docs/protocol entry has contracts but no CoinGecko id, that identity
// confirms the join; the ticker only corroborates. prices = coins map of
// /prices/current/{coingecko:id,...,chain:address,...}.
function coinLinks(prices, cgIds, contracts) {
  const out = [];
  for (const c of contracts) {
    const x = prices[c.key];
    if (!x || !num(x.price) || x.price === 1) continue;
    for (const id of cgIds) {
      const g = prices['coingecko:' + id];
      if (g && g.price === x.price && g.timestamp === x.timestamp && symKey(g.symbol) === symKey(x.symbol)) out.push({ geckoId: id, chain: c.chain, address: c.address });
    }
  }
  return out;
}

// ---------- identities ----------
// Stable identity of a discovered asset across discovery passes.
const assetId = (a) => (a.llamaId ? 'llama:' + a.llamaId : a.geckoId ? 'gecko:' + a.geckoId : 'key:' + a.key);

// coins.llama.fi key: CoinGecko id when known, else a contract (chain key = the
// DefiLlama chainConfig key, or the normalised chain name; they coincide).
function coinKeyOf(a) {
  if (typeof a.geckoId === 'string' && /^[a-z0-9-]+$/.test(a.geckoId)) return 'coingecko:' + a.geckoId;
  const ad = (a.addresses || []).find((x) => isEvm(x.address) && (x.llamaKey || x.chain));
  if (!ad) return null;
  const ck = ad.llamaKey || chainKey(ad.chain);
  return /^[a-z0-9-]+$/.test(ck) ? `${ck}:${ad.address.toLowerCase()}` : null;
}

// ---------- Coin Metrics mapping ----------
// Candidates come from the CM catalog by ticker prefix (paxg, pyusd_eth, ...);
// a candidate is only accepted when its latest SplyCur matches one of our own
// supply measures of the subject. Tolerance = the larger 30-day log move of
// either side over the past year (what timing/definition differences can
// plausibly explain); a ticker twin is typically off by far more. Chain-suffixed
// ids (pyusd_eth) are only compared with chains whose name starts with the
// suffix; unsuffixed ids with asset totals. An accepted unsuffixed id whose
// latest value matches one chain's own measure more closely than any asset
// total covers that chain only (scope = chain name): its history stands in for
// the asset, and the other chains' current supply has to be added to the level.
// A suffixed id's scope is the chain whose measure it matched.
// subjects: [{ key, symbol, measures:[{chain|null, t, v}], tau }]; cmRows: { id: [{time, SplyCur}] }
function matchCoinMetrics(catalogIds, subjects, cmRows) {
  const DAY = 86400;
  const out = {};
  for (const s of subjects) {
    const sym = symKey(s.symbol);
    if (!sym) continue;
    let best = null;
    for (const id of catalogIds) {
      if (id !== sym && !id.startsWith(sym + '_')) continue;
      const suffix = id.includes('_') ? id.slice(id.indexOf('_') + 1) : null;
      const rows = (cmRows[id] || []).map((r) => ({ t: Math.floor(Date.parse(r.time) / 1000 / DAY) * DAY, v: Number(r.SplyCur) })).filter((r) => Number.isFinite(r.t) && r.v > 0);
      if (!rows.length) continue;
      const last = rows[rows.length - 1];
      const byT = new Map(rows.map((r) => [r.t, r.v]));
      let tauCm = 0;
      for (const r of rows) if (r.t > last.t - 365 * DAY && byT.has(r.t - 30 * DAY)) tauCm = Math.max(tauCm, Math.abs(Math.log(r.v / byT.get(r.t - 30 * DAY))));
      const tau = Math.max(tauCm, s.tau || 0);
      const near = s.measures.filter((m) => m.v > 0 && m.t >= last.t && m.t <= last.t + 2 * DAY);
      const ms = near.filter((m) => (suffix ? m.chain && chainKey(m.chain).startsWith(suffix) : !m.chain));
      if (!ms.length) continue;
      const dist = ms.map((m) => ({ d: Math.abs(Math.log(last.v / m.v)), chain: m.chain }));
      const d = Math.min(...dist.map((x) => x.d));
      // A chain-suffixed id covers the chain whose own measure it matched.
      let scope = suffix ? (dist.find((x) => x.d === d) || {}).chain || null : null;
      if (!suffix) {
        let bc = null;
        for (const m of near) if (m.chain) { const dc = Math.abs(Math.log(last.v / m.v)); if (!bc || dc < bc.d) bc = { d: dc, chain: m.chain }; }
        if (bc && bc.d < d) scope = bc.chain;
      }
      if (d <= tau && (!best || d < best.d || (d === best.d && !suffix))) best = { id, d, tau, asOf: last.t, scope };
    }
    if (best) out[s.key] = best;
  }
  return out;
}

module.exports = {
  ISSUER,
  TIERS,
  chainKey,
  makeChainNamer,
  normAddr,
  isEvm,
  feeLabels,
  feeLabelNames,
  parseDocsIndex,
  parseDocsMainnet,
  discover,
  selectPegPeers,
  selectGoldRefs,
  matchCoinMetrics,
  assetId,
  coinKeyOf,
  coinLinks,
};
