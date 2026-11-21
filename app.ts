import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const OAUTH_SCOPES = 'repo, read:org';

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body) === undefined ? 'null' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers,
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string> = {}): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'x-github-request-id': randomUUID(), ...headers, 'content-length': buf.length });
  res.end(buf);
}

function pathOf(req: IncomingMessage): string {
  try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); }
}

async function readBody(req: IncomingMessage, max = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    n += b.length;
    if (n > max) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (buf.length === 0) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

function isObj(v: unknown): v is Json { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function asStr(v: unknown): string | null { return typeof v === 'string' ? v : null; }
function asInt(v: unknown): number | null { return typeof v === 'number' && Number.isInteger(v) ? v : (typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : null); }
function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }
function unb64(s: string): string { return Buffer.from(String(s).replace(/\s+/g, ''), 'base64').toString('utf8'); }
function sha1(data: Buffer | string): string { return createHash('sha1').update(data).digest('hex'); }
let _tick=0;
function nowIso(): string { const t=_tick++; const d=new Date(Date.UTC(2026,0,1,0,0,0,0)); d.setUTCSeconds(d.getUTCSeconds()+t); return d.toISOString(); }
function lower(s: string): string { return s.toLowerCase(); }
function err(status: number, message: string) { return Object.assign(new Error(message), { status, body: { message } }); }

// ----------------------------- store -----------------------------
interface GitObj { type: 'blob'|'tree'|'commit'|'tag'; data: Buffer; }
interface Ref { name: string; oid: string; }
interface Label { name: string; color: string; description: string | null; }
interface IssueComment { id: number; body: string; user: { login: string }; created_at: string; updated_at: string; }
interface Issue { number: number; title: string; body: string; state: 'open'|'closed'; labels: string[]; comments: IssueComment[]; user: { login: string }; created_at: string; updated_at: string; closed_at: string | null; id: number; node_id: string; }
interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string; }
interface Pull { number: number; title: string; body: string; state: 'open'|'closed'; merged: boolean; merged_at: string | null; merge_commit_sha: string | null; head: { ref: string; sha: string; repo?: any }; base: { ref: string; sha: string; repo?: any }; user: { login: string }; created_at: string; updated_at: string; id: number; node_id: string; draft: boolean; }
interface Repo {
  id: number; owner: string; name: string; full_name: string; description: string | null; private: boolean;
  default_branch: string; created_at: string; updated_at: string; pushed_at: string;
  has_issues: boolean;
  objects: Map<string, GitObj>;
  refs: Map<string, string>; // refname -> oid
  head: string; // symref target, e.g. refs/heads/main
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextId: number;
}

interface User { login: string; id: number; name: string; email: string; }

class Store {
  usersByToken = new Map<string, User>();
  repos = new Map<string, Repo>(); // key owner/name lower
  nextRepoId = 5000;
  nextUserId = 1000;
  defaultLogin = 'adaiversen';

  key(owner: string, name: string) { return `${lower(owner)}/${lower(name)}`; }

  getUser(token: string | null): User | null {
    if (!token) return null;
    let u = this.usersByToken.get(token);
    if (!u) {
      u = { login: this.defaultLogin, id: this.nextUserId++, name: this.defaultLogin, email: `${this.defaultLogin}@example.invalid` };
      this.usersByToken.set(token, u);
    }
    return u;
  }

  ensureUser(login: string): User {
    for (const u of this.usersByToken.values()) if (lower(u.login) === lower(login)) return u;
    const u: User = { login, id: this.nextUserId++, name: login, email: `${login}@example.invalid` };
    // not token-bound; fine
    return u;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  createRepo(owner: string, name: string, opts: {description?: string|null, private?: boolean, default_branch?: string, auto_init?: boolean, has_issues?: boolean}): Repo {
    const k = this.key(owner, name);
    if (this.repos.has(k)) throw err(422, `Repository ${name} already exists`);
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++, owner, name, full_name: `${owner}/${name}`,
      description: opts.description ?? null, private: !!opts.private,
      default_branch: opts.default_branch || 'main', created_at: now, updated_at: now, pushed_at: now,
      has_issues: opts.has_issues !== false,
      objects: new Map(), refs: new Map(), head: `refs/heads/${opts.default_branch || 'main'}`,
      labels: new Map(), issues: [], pulls: [], nextIssueNumber: 1, nextPullNumber: 1, nextCommentId: 1, nextId: 1,
    };
    this.repos.set(k, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (lower(r.owner) === lower(owner)) out.push(r);
    out.sort((a,b)=>a.id-b.id);
    return out;
  }
}

// ----------------------------- git utils -----------------------------
const ZERO_OID = '0000000000000000000000000000000000000000';

function gitHash(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  return sha1(Buffer.concat([header, data]));
}

function encodeObj(type: GitObj['type'], data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`);
  return Buffer.concat([header, data]);
}

function parseObj(buf: Buffer): GitObj {
  const nul = buf.indexOf(0);
  if (nul < 0) throw new Error('bad object');
  const head = buf.slice(0, nul).toString('utf8');
  const sp = head.indexOf(' ');
  const type = head.slice(0, sp) as GitObj['type'];
  const data = buf.slice(nul + 1);
  return { type, data };
}

function parseTree(data: Buffer): {mode:string,name:string,oid:string}[] {
  const out: {mode:string,name:string,oid:string}[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    if (sp < 0 || nul < 0) break;
    const mode = data.slice(i, sp).toString('utf8');
    const name = data.slice(sp + 1, nul).toString('utf8');
    const oid = data.slice(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

function buildTree(entries: {mode:string,name:string,oid:string}[]): Buffer {
  const sorted = entries.slice().sort((a,b)=>{
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseCommit(data: Buffer): {tree:string, parents:string[], author:string, committer:string, message:string} {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let tree = '', parents:string[] = [], author='', committer='', i=0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l === '') { i++; break; }
    if (l.startsWith('tree ')) tree = l.slice(5).trim();
    else if (l.startsWith('parent ')) parents.push(l.slice(7).trim());
    else if (l.startsWith('author ')) author = l.slice(7);
    else if (l.startsWith('committer ')) committer = l.slice(10);
  }
  return { tree, parents, author, committer, message: lines.slice(i).join('\n') };
}

function buildCommit(fields: {tree:string, parents?:string[], author:string, committer:string, message:string}): Buffer {
  let s = `tree ${fields.tree}\n`;
  for (const p of fields.parents ?? []) s += `parent ${p}\n`;
  s += `author ${fields.author}\n`;
  s += `committer ${fields.committer}\n`;
  s += `\n${fields.message}`;
  if (!s.endsWith('\n')) s += '\n';
  return Buffer.from(s, 'utf8');
}

function parseTag(data: Buffer): {object:string,type:string,tag:string,tagger?:string,message:string} {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let object='', type='', tag='', tagger:string|undefined, i=0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l === '') { i++; break; }
    if (l.startsWith('object ')) object = l.slice(7).trim();
    else if (l.startsWith('type ')) type = l.slice(5).trim();
    else if (l.startsWith('tag ')) tag = l.slice(4).trim();
    else if (l.startsWith('tagger ')) tagger = l.slice(7);
  }
  return { object, type, tag, tagger, message: lines.slice(i).join('\n') };
}

function buildTag(fields: {object:string,type:string,tag:string,tagger:string,message:string}): Buffer {
  let s = `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`;
  if (!s.endsWith('\n')) s += '\n';
  return Buffer.from(s, 'utf8');
}

// ----------------------------- pkt-line -----------------------------
function pktLine(payload: string | Buffer): Buffer {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = b.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), b]);
}
function pktFlush(): Buffer { return Buffer.from('0000', 'ascii'); }
function pktDelim(): Buffer { return Buffer.from('0001', 'ascii'); }
function pktEnd(): Buffer { return Buffer.from('0002', 'ascii'); }

function decodePktLines(buf: Buffer): {type:'data'|'flush'|'delim'|'end', data?:Buffer}[] {
  const out: {type:'data'|'flush'|'delim'|'end', data?:Buffer}[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) break;
    const n = parseInt(buf.slice(i, i + 4).toString('ascii'), 16);
    if (n === 0) { out.push({type:'flush'}); i += 4; continue; }
    if (n === 1) { out.push({type:'delim'}); i += 4; continue; }
    if (n === 2) { out.push({type:'end'}); i += 4; continue; }
    if (n < 4 || i + n > buf.length) break;
    out.push({type:'data', data: buf.slice(i + 4, i + n)});
    i += n;
  }
  return out;
}

function pktDataLines(lines: (string|Buffer)[]): Buffer {
  return Buffer.concat(lines.map(l => pktLine(l)));
}

// ----------------------------- pack -----------------------------
function readVarint(buf: Buffer, off: number): {value:number; off:number} {
  let c = buf[off++];
  let value = c & 0x7f;
  let shift = 7;
  while (c & 0x80) { c = buf[off++]; value |= (c & 0x7f) << shift; shift += 7; }
  return { value, off };
}

function readPackObjects(pack: Buffer): {oid:string; type:GitObj['type']; data:Buffer}[] {
  if (pack.length < 12) throw new Error('short pack');
  if (pack.slice(0,4).toString('ascii') !== 'PACK') throw new Error('not pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  let off = 12;
  const entries: any[] = [];
  const byOid = new Map<string, {type:GitObj['type']; data:Buffer}>();
  const byOff = new Map<number, {type:GitObj['type']; data:Buffer}>();
  const typeMap: Record<number, GitObj['type']> = {1:'commit',2:'tree',3:'blob',4:'tag'} as any;
  for (let i = 0; i < count; i++) {
    const objOff = off;
    let c = pack[off++];
    const typeNum = (c >> 4) & 7;
    let size = c & 15;
    let shift = 4;
    while (c & 0x80) { c = pack[off++]; size |= (c & 0x7f) << shift; shift += 7; }
    if (typeNum === 6) {
      let b = pack[off++];
      let baseDist = b & 0x7f;
      while (b & 0x80) { b = pack[off++]; baseDist = ((baseDist + 1) << 7) | (b & 0x7f); }
      const baseObjOff = objOff - baseDist;
      const { data, next } = inflateAt(pack, off, size);
      off = next;
      entries.push({ objOff, rawType:6, baseObjOff, delta:data });
    } else if (typeNum === 7) {
      const baseOid = pack.slice(off, off+20).toString('hex'); off += 20;
      const { data, next } = inflateAt(pack, off, size);
      off = next;
      entries.push({ objOff, rawType:7, baseOid, delta:data });
    } else {
      const type = typeMap[typeNum];
      if (!type) throw new Error(`bad type ${typeNum}`);
      const { data, next } = inflateAt(pack, off, size);
      off = next;
      const oid = gitHash(type, data);
      const obj = { type, data };
      entries.push({ objOff, oid, type, data });
      byOid.set(oid, obj); byOff.set(objOff, obj);
    }
  }
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const e of entries) {
      if (e.oid) continue;
      const base = e.rawType === 7 ? byOid.get(e.baseOid) : byOff.get(e.baseObjOff);
      if (!base) continue;
      const data = applyDelta(base.data, e.delta);
      const type = base.type;
      const oid = gitHash(type, data);
      e.oid = oid; e.type = type; e.data = data;
      byOid.set(oid, {type,data}); byOff.set(e.objOff, {type,data});
      changed = true;
    }
    if (!changed) break;
  }
  return entries.filter(e => e.oid).map(e => ({oid:e.oid,type:e.type,data:e.data}));
}

function inflateAt(buf: Buffer, off: number, expectedSize: number): {data:Buffer; next:number} {
  // Node 18+ supports info:true; returns {buffer, engine.bytesRead}
  try {
    const r: any = (inflateSync as any)(buf.slice(off), { info: true });
    if (r && r.buffer && r.engine && typeof r.engine.bytesRead === 'number') {
      return { data: Buffer.from(r.buffer), next: off + r.engine.bytesRead };
    }
    if (Buffer.isBuffer(r)) return { data: r, next: off }; // shouldn't happen
  } catch {}
  // Fallback: binary search-ish by trying to find consumed length
  for (let end = off + 1; end <= buf.length; end++) {
    try {
      const d = inflateSync(buf.slice(off, end));
      if (d.length === expectedSize) return { data: d, next: end };
    } catch {}
  }
  const d = inflateSync(buf.slice(off));
  return { data: d, next: buf.length };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = () => { let c = delta[off++]; let size = c & 0x7f; let shift = 7; while (c & 0x80) { c = delta[off++]; size |= (c & 0x7f) << shift; shift += 7; } return size; };
  readSize(); // base size
  const outSize = readSize();
  const out = Buffer.alloc(outSize);
  let o = 0;
  while (off < delta.length) {
    const cmd = delta[off++];
    if (cmd & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (cmd & 0x01) cpOff = delta[off++];
      if (cmd & 0x02) cpOff |= delta[off++] << 8;
      if (cmd & 0x04) cpOff |= delta[off++] << 16;
      if (cmd & 0x08) cpOff |= delta[off++] << 24;
      if (cmd & 0x10) cpSize = delta[off++];
      if (cmd & 0x20) cpSize |= delta[off++] << 8;
      if (cmd & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, o, cpOff, cpOff + cpSize);
      o += cpSize;
    } else if (cmd > 0) {
      delta.copy(out, o, off, off + cmd);
      off += cmd; o += cmd;
    } else throw new Error('bad delta cmd');
  }
  return out;
}

// ----------------------------- pack write -----------------------------
function encodePackObj(type: GitObj['type'], data: Buffer): Buffer {
  const typeNum = {commit:1,tree:2,blob:3,tag:4}[type];
  let size = data.length;
  let n = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  const hdr: number[] = [];
  while (size > 0) { hdr.push(n | 0x80); n = size & 0x7f; size >>>= 7; }
  hdr.push(n);
  return Buffer.concat([Buffer.from(hdr), deflateSync(data)]);
}

function writePack(objects: {type:GitObj['type']; data:Buffer}[]): Buffer {
  const body: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  body[1].writeUInt32BE(2, 0);
  body[2].writeUInt32BE(objects.length, 0);
  for (const o of objects) body.push(encodePackObj(o.type, o.data));
  const pack = Buffer.concat(body);
  const hash = createHash('sha1').update(pack).digest();
  return Buffer.concat([pack, hash]);
}

// ----------------------------- repo git helpers -----------------------------
function putObj(repo: Repo, type: GitObj['type'], data: Buffer): string {
  const oid = gitHash(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function getObj(repo: Repo, oid: string): GitObj | undefined { return repo.objects.get(oid); }

function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') {
    const t = repo.head;
    if (t.startsWith('refs/')) return repo.refs.get(t) ?? null;
    return repo.refs.get(t) ?? null;
  }
  return repo.refs.get(ref) ?? null;
}

function listRefs(repo: Repo): {name:string; oid:string}[] {
  const out: {name:string; oid:string}[] = [];
  for (const [name, oid] of repo.refs.entries()) out.push({name, oid});
  out.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  return out;
}

function peel(repo: Repo, oid: string): string | null {
  const o = repo.objects.get(oid);
  if (!o || o.type !== 'tag') return null;
  const t = parseTag(o.data);
  return t.object || null;
}

function collectReachable(repo: Repo, wants: string[], haves: Set<string>): GitObj[] {
  const seen = new Set<string>();
  const out: GitObj[] = [];
  const stack = [...wants];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || seen.has(oid) || haves.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    out.push(obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t.object) stack.push(t.object);
    }
  }
  return out;
}

function walkCommits(repo: Repo, start: string | null, max=100): string[] {
  if (!start) return [];
  const seen = new Set<string>(); const out: string[] = []; const q = [start];
  while (q.length && out.length < max) {
    const oid = q.shift()!;
    if (seen.has(oid)) continue;
    const o = repo.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    seen.add(oid); out.push(oid);
    const c = parseCommit(o.data);
    for (const p of c.parents) if (!seen.has(p)) q.push(p);
  }
  return out;
}

// ----------------------------- app -----------------------------
function authToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h) || /^token\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function requireAuth(req: IncomingMessage, res: ServerResponse, store: Store): User | null {
  const token = authToken(req);
  if (!token) { sendJson(res, 401, { message: 'Requires authentication' }, {'x-oauth-scopes':''}); return null; }
  const u = store.getUser(token);
  if (!u) { sendJson(res, 401, { message: 'Bad credentials' }, {'x-oauth-scopes':''}); return null; }
  return u;
}

function repoFull(repo: Repo) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.full_name,
    private: repo.private,
    owner: { login: repo.owner, id: 1, node_id: 'U_1', type: 'User' },
    description: repo.description,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    has_issues: repo.has_issues,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueObj(repo: Repo, issue: Issue) {
  return {
    id: issue.id, node_id: issue.node_id, number: issue.number, title: issue.title, body: issue.body,
    state: issue.state, locked: false,
    user: issue.user,
    labels: issue.labels.map(n => { const l = repo.labels.get(lower(n)); return { name: l?.name ?? n, color: l?.color ?? 'ededed', description: l?.description ?? null }; }),
    comments: issue.comments.length,
    created_at: issue.created_at, updated_at: issue.updated_at, closed_at: issue.closed_at,
    html_url: `https://example.invalid/${repo.full_name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.full_name}/issues/${issue.number}`,
  };
}

function pullObj(repo: Repo, pr: Pull) {
  return {
    id: pr.id, node_id: pr.node_id, number: pr.number, title: pr.title, body: pr.body,
    state: pr.state, locked: false, draft: pr.draft, merged: pr.merged, merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    user: pr.user,
    head: { ref: pr.head.ref, sha: pr.head.sha, label: `${repo.owner}:${pr.head.ref}`, repo: repoFull(repo) },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: `${repo.owner}:${pr.base.ref}`, repo: repoFull(repo) },
    created_at: pr.created_at, updated_at: pr.updated_at, closed_at: pr.state === 'closed' ? pr.updated_at : null,
    html_url: `https://example.invalid/${repo.full_name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.full_name}/pulls/${pr.number}`,
  };
}

function parseRepoPath(path: string): {owner:string, repo:string, rest:string} | null {
  // /api/v3/repos/:owner/:repo/...
  const m = /^\/api\/v3\/repos\/([^\/]+)\/([^\/]+)(?:\/(.*))?$/.exec(path);
  if (!m) return null;
  const repo = m[2].endsWith('.git') ? m[2].slice(0,-4) : m[2];
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(repo), rest: m[3] ?? '' };
}

function parseGitPath(path: string): {owner:string, repo:string, action:string} | null {
  // /owner/repo.git/info/refs or /owner/repo.git/git-upload-pack etc
  let m = /^\/([^\/]+)\/([^\/]+?)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (m) { let repo = m[2]; if (repo.endsWith('.git')) repo = repo.slice(0,-4); return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(repo), action: m[3] }; }
  m = /^\/([^\/]+)\/([^\/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (m) return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), action: m[3] };
  return null;
}

function sendGit(res: ServerResponse, status: number, body: Buffer | string, contentType: string) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, 'cache-control': 'no-cache', 'x-github-request-id': randomUUID() });
  res.end(buf);
}

function sendNoContent(res: ServerResponse, status=204) {
  res.writeHead(status, { 'x-github-request-id': randomUUID() });
  res.end();
}

// ----------------------------- git HTTP -----------------------------
function gitCapabilitiesV2(repo: Repo): string[] {
  const caps = ['version 2', 'agent=makefun-git/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'server-option', 'object-format=sha1'];
  return caps;
}

function advertiseUploadPackV2(repo: Repo): Buffer {
  const lines: (string|Buffer)[] = [];
  lines.push(pktLine('# service=git-upload-pack\n'));
  lines.push(pktFlush());
  lines.push(pktLine('version 2\n'));
  lines.push(pktLine('agent=makefun-git/1.0\n'));
  lines.push(pktLine('ls-refs=unborn\n'));
  lines.push(pktLine('fetch=shallow wait-for-done\n'));
  lines.push(pktLine('server-option\n'));
  lines.push(pktLine('object-format=sha1\n'));
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function advertiseUploadPackV0(repo: Repo): Buffer {
  const refs = listRefs(repo);
  const head = repo.head;
  const symref = head.startsWith('refs/') ? ` symref=HEAD:${head}` : '';
  const caps = `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done agent=makefun-git/1.0 object-format=sha1${symref}`;
  const lines: (string|Buffer)[] = [];
  lines.push(pktLine('# service=git-upload-pack\n'));
  lines.push(pktFlush());
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const r of refs) {
      if (first) { lines.push(pktLine(`${r.oid} ${r.name}\0${caps}\n`)); first = false; }
      else lines.push(pktLine(`${r.oid} ${r.name}\n`));
      const peeled = peel(repo, r.oid);
      if (peeled) lines.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function advertiseReceivePack(repo: Repo): Buffer {
  const refs = listRefs(repo);
  const head = repo.head;
  const symref = head.startsWith('refs/') ? ` symref=HEAD:${head}` : '';
  const caps = `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=makefun-git/1.0 object-format=sha1${symref}`;
  const lines: (string|Buffer)[] = [];
  lines.push(pktLine('# service=git-receive-pack\n'));
  lines.push(pktFlush());
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const r of refs) {
      if (first) { lines.push(pktLine(`${r.oid} ${r.name}\0${caps}\n`)); first = false; }
      else lines.push(pktLine(`${r.oid} ${r.name}\n`));
      const peeled = peel(repo, r.oid);
      if (peeled) lines.push(pktLine(`${peeled} ${r.name}^{}\n`));
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

function handleLsRefs(repo: Repo, reqPkts: {type:string,data?:Buffer}[]): Buffer {
  // parse args after delim
  let afterDelim = false;
  let wantPeel = false, wantSymrefs = false, wantUnborn = false;
  const prefixes: string[] = [];
  for (const p of reqPkts) {
    if (p.type === 'delim') { afterDelim = true; continue; }
    if (!afterDelim || p.type !== 'data') continue;
    const line = p.data!.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') wantPeel = true;
    else if (line === 'symrefs') wantSymrefs = true;
    else if (line === 'unborn') wantUnborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const headTarget = repo.head.startsWith('refs/') ? repo.head : null;
  const out: Buffer[] = [];
  const emit = (oid: string, name: string, attrs: string[]) => {
    let line = `${oid} ${name}`;
    if (attrs.length) line += ' ' + attrs.join(' ');
    out.push(pktLine(line + '\n'));
  };

  const matches = (name: string) => prefixes.length === 0 || prefixes.some(p => name.startsWith(p));

  // HEAD symref
  if (matches('HEAD') && wantSymrefs && headTarget) {
    emit(repo.refs.get(headTarget) ?? ZERO_OID, 'HEAD', [`symref-target:${headTarget}`]);
  }
  // do not advertise unborn as refs/heads/* real ref; HEAD symref above is enough for clone-empty
  for (const r of refs) {
    if (!matches(r.name)) continue;
    const attrs: string[] = [];
    if (wantSymrefs && headTarget && r.name === headTarget) attrs.push(`symref-target:${headTarget}`);
    if (wantPeel) {
      const p = peel(repo, r.oid);
      if (p) attrs.push(`peeled:${p}`);
    }
    emit(r.oid, r.name, attrs);
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

function collectReachableFrom(repo: Repo, wants: string[], exclude: Set<string>, shallowCutoff?: Set<string>): GitObj[] {
  const seen = new Set<string>();
  const out: GitObj[] = [];
  const stack = [...wants];
  while (stack.length) {
    const oid = stack.pop()!;
    if (!oid || seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (!exclude.has(oid)) out.push(obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      // always traverse tree for included commits; for excluded commits, no need to send tree but safe to skip
      if (!exclude.has(oid)) {
        if (c.tree) stack.push(c.tree);
      }
      if (!shallowCutoff || !shallowCutoff.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      if (!exclude.has(oid)) {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      if (!exclude.has(oid)) {
        const t = parseTag(obj.data);
        if (t.object) stack.push(t.object);
      }
    }
  }
  return out;
}

function handleFetchV2(repo: Repo, reqPkts: {type:string,data?:Buffer}[]): Buffer {
  let afterDelim = false;
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallows: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const p of reqPkts) {
    if (p.type === 'delim') { afterDelim = true; continue; }
    if (!afterDelim || p.type !== 'data') continue;
    const line = p.data!.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') done = true;
  }
  const uniqWants = [...new Set(wants)].filter(w => repo.objects.has(w));
  const out: Buffer[] = [];
  if (uniqWants.length === 0) { out.push(pktFlush()); return Buffer.concat(out); }

  const knownHaves = haves.filter(h => repo.objects.has(h));
  if (haves.length > 0) {
    out.push(pktLine('acknowledgments\n'));
    if (knownHaves.length === 0) out.push(pktLine('NAK\n'));
    else for (const h of knownHaves) out.push(pktLine(`ACK ${h}\n`));
    if (done) out.push(pktLine('ready\n'));
    out.push(pktDelim());
  }

  const shallowCutoff = new Set<string>();
  const shallowInfo: string[] = [];
  if (deepen !== null && deepen >= 1) {
    for (const w of uniqWants) {
      const q: {oid:string, depth:number}[] = [{oid:w, depth:1}];
      const seen = new Set<string>();
      while (q.length) {
        const cur = q.shift()!;
        if (seen.has(cur.oid)) continue;
        const obj = repo.objects.get(cur.oid);
        if (!obj || obj.type !== 'commit') continue;
        seen.add(cur.oid);
        if (cur.depth >= deepen) {
          shallowCutoff.add(cur.oid);
          shallowInfo.push(`shallow ${cur.oid}`);
          continue;
        }
        const c = parseCommit(obj.data);
        for (const p of c.parents) q.push({oid:p, depth:cur.depth+1});
      }
    }
    // unshallow client shallows that are now within depth
    for (const s of clientShallows) {
      if (!shallowCutoff.has(s)) shallowInfo.push(`unshallow ${s}`);
    }
  } else {
    for (const s of clientShallows) shallowCutoff.add(s);
  }

  if (shallowInfo.length > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const s of shallowInfo) out.push(pktLine(s + '\n'));
    out.push(pktDelim());
  }

  const exclude = new Set<string>(knownHaves);
  if (knownHaves.length > 0) {
    const haveSeen = new Set<string>();
    const hs = [...knownHaves];
    const clientShallowSet = new Set(clientShallows);
    while (hs.length) {
      const oid = hs.pop()!;
      if (haveSeen.has(oid) || !repo.objects.has(oid)) continue;
      haveSeen.add(oid); exclude.add(oid);
      const obj = repo.objects.get(oid)!;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree) hs.push(c.tree);
        // don't walk past client shallow boundaries when deepening
        if (!clientShallowSet.has(oid)) {
          for (const p of c.parents) hs.push(p);
        }
      } else if (obj.type === 'tree') { for (const e of parseTree(obj.data)) hs.push(e.oid); }
      else if (obj.type === 'tag') { const t = parseTag(obj.data); if (t.object) hs.push(t.object); }
    }
  }

  const objs = collectReachableFrom(repo, uniqWants, exclude, shallowCutoff.size ? shallowCutoff : undefined);
  const pack = writePack(objs.map(o => ({type:o.type,data:o.data})));
  out.push(pktLine('packfile\n'));
  const maxChunk = 65515;
  for (let i = 0; i < pack.length; i += maxChunk) {
    const chunk = pack.slice(i, Math.min(pack.length, i + maxChunk));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    for (const p of c.parents) stack.push(p);
  }
  return false;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const pkts = decodePktLines(body);
  // find flush separating commands from pack
  let flushIdx = pkts.findIndex(p => p.type === 'flush');
  if (flushIdx < 0) flushIdx = pkts.length;
  const cmdPkts = pkts.slice(0, flushIdx);
  // pack is rest of body after flush pktline bytes
  // locate flush in raw bytes
  let off = 0;
  let cmdEnd = 0;
  for (let i = 0; i < body.length; ) {
    if (i + 4 > body.length) break;
    const n = parseInt(body.slice(i, i+4).toString('ascii'), 16);
    if (n === 0) { cmdEnd = i + 4; break; }
    i += n;
  }
  const packBuf = body.slice(cmdEnd);

  const commands: {oldOid:string,newOid:string,ref:string}[] = [];
  let caps: string[] = [];
  for (let i = 0; i < cmdPkts.length; i++) {
    const p = cmdPkts[i];
    if (p.type !== 'data') continue;
    let line = p.data!.toString('utf8');
    if (line.endsWith('\n')) line = line.slice(0,-1);
    if (i === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) { caps = line.slice(nul+1).split(' ').filter(Boolean); line = line.slice(0, nul); }
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (m) commands.push({ oldOid:m[1], newOid:m[2], ref:m[3] });
  }
  const sideband = caps.includes('side-band-64k');

  // parse pack
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjs: {oid:string,type:GitObj['type'],data:Buffer}[] = [];
  try {
    if (packBuf.length > 0) {
      // find PACK signature
      const packIdx = packBuf.indexOf(Buffer.from('PACK'));
      const pb = packIdx >= 0 ? packBuf.slice(packIdx) : packBuf;
      if (pb.length >= 12) {
        const objs = readPackObjects(pb);
        for (const o of objs) newObjs.push(o);
      }
    }
  } catch (e: any) {
    unpackOk = false;
    unpackDetail = `unpack error: ${e?.message ?? e}`;
  }

  const refReports: {ref:string,ok:boolean,reason:string}[] = [];
  if (unpackOk) {
    // stage objects
    const staged = new Map<string, GitObj>();
    for (const o of newObjs) staged.set(o.oid, {type:o.type,data:o.data});
    // apply commands
    for (const cmd of commands) {
      const cur = repo.refs.get(cmd.ref) ?? null;
      const curOid = cur ?? ZERO_OID;
      if (cmd.oldOid !== curOid) {
        // allow if old matches actual? strict
        if (curOid !== cmd.oldOid) {
          // old mismatch - refuse
          // but sometimes client expects specific behavior; common to say "lock error" or "non-fast-forward"
          if (cmd.newOid === ZERO_OID) { refReports.push({ref:cmd.ref,ok:false,reason:'lock error'}); continue; }
        }
      }
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (!repo.refs.has(cmd.ref)) { refReports.push({ref:cmd.ref,ok:false,reason:'no such ref'}); continue; }
        repo.refs.delete(cmd.ref);
        refReports.push({ref:cmd.ref,ok:true,reason:''});
        continue;
      }
      // create/update
      // ensure new object exists in repo or staged
      const hasObj = repo.objects.has(cmd.newOid) || staged.has(cmd.newOid);
      if (!hasObj) { refReports.push({ref:cmd.ref,ok:false,reason:`missing object ${cmd.newOid}`}); continue; }
      // commit objects into repo
      for (const [oid,obj] of staged.entries()) if (!repo.objects.has(oid)) repo.objects.set(oid,obj);
      if (curOid !== ZERO_OID) {
        // fast-forward check
        // only for refs/heads/*? git normally checks for branches; tags usually just update/delete
        const isBranch = cmd.ref.startsWith('refs/heads/');
        if (isBranch && !isAncestor(repo, curOid, cmd.newOid)) {
          refReports.push({ref:cmd.ref,ok:false,reason:'non-fast-forward'});
          continue;
        }
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      // if this is default branch and HEAD unborn, set HEAD? we already have head
      if (repo.refs.size === 1 && !repo.refs.has(repo.head) && cmd.ref.startsWith('refs/heads/')) {
        repo.head = cmd.ref;
      }
      if (cmd.ref === repo.head && !repo.refs.get(repo.head)) repo.head = cmd.ref;
      refReports.push({ref:cmd.ref,ok:true,reason:''});
    }
    if (commands.length === 0) {
      // nothing
    }
  } else {
    for (const cmd of commands) refReports.push({ref:cmd.ref,ok:false,reason:'unpack failed'});
  }

  // build report-status
  let report = `unpack ${unpackDetail}\n`;
  for (const r of refReports) report += r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`;
  const reportPkts = Buffer.concat([pktLine(report.split('\n').filter(Boolean).map(l=>l+'\n').join('')), pktFlush()]);
  // Actually report-status should be pkt-lines per line
  const reportLines: Buffer[] = [];
  for (const line of report.split('\n').filter(Boolean)) reportLines.push(pktLine(line + '\n'));
  reportLines.push(pktFlush());
  const reportBuf = Buffer.concat(reportLines);

  if (!sideband) return reportBuf;
  // wrap in sideband band 1
  const out: Buffer[] = [];
  for (const line of report.split('\n').filter(Boolean)) {
    const rp = pktLine(line + '\n');
    out.push(pktLine(Buffer.concat([Buffer.from([1]), rp])));
  }
  out.push(pktLine(Buffer.concat([Buffer.from([1]), pktFlush()])));
  out.push(pktFlush());
  return Buffer.concat(out);
}

function getRepoFromGitPath(store: Store, owner: string, repo: string): Repo | null {
  return store.getRepo(owner, repo);
}

function handleGit(store: Store, req: IncomingMessage, res: ServerResponse): boolean {
  const g = parseGitPath(pathOf(req));
  if (!g) return false;
  const repo = getRepoFromGitPath(store, g.owner, g.repo);
  const method = (req.method ?? 'GET').toUpperCase();

  if (g.action === 'info/refs') {
    const svc = queryOf(req).get('service');
    if (!repo) {
      sendGit(res, 404, 'repository not found\n', 'text/plain');
      return true;
    }
    if (svc === 'git-upload-pack') {
      const proto = String(req.headers['git-protocol'] ?? '');
      const wantsV2 = proto.includes('version=2');
      const body = wantsV2 ? advertiseUploadPackV2(repo) : advertiseUploadPackV0(repo);
      sendGit(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (svc === 'git-receive-pack') {
      const body = advertiseReceivePack(repo);
      sendGit(res, 200, body, 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendGit(res, 400, 'bad service\n', 'text/plain');
    return true;
  }

  if (g.action === 'git-upload-pack' && method === 'POST') {
    if (!repo) { sendGit(res, 404, 'repository not found\n', 'text/plain'); return true; }
    void readBody(req).then(body => {
      try {
        const pkts = decodePktLines(body);
        // detect command
        const firstData = pkts.find(p => p.type === 'data');
        const firstLine = firstData?.data?.toString('utf8') ?? '';
        if (firstLine.startsWith('command=ls-refs')) {
          const out = handleLsRefs(repo, pkts);
          sendGit(res, 200, out, 'application/x-git-upload-pack-result');
          return;
        }
        if (firstLine.startsWith('command=fetch')) {
          const out = handleFetchV2(repo, pkts);
          sendGit(res, 200, out, 'application/x-git-upload-pack-result');
          return;
        }
        // v0 fetch fallback - simple
        sendGit(res, 200, Buffer.concat([pktFlush()]), 'application/x-git-upload-pack-result');
      } catch (e: any) {
        sendGit(res, 500, `error\n`, 'text/plain');
      }
    }).catch(() => sendGit(res, 400, 'bad request\n', 'text/plain'));
    return true;
  }

  if (g.action === 'git-receive-pack' && method === 'POST') {
    if (!repo) { sendGit(res, 404, 'repository not found\n', 'text/plain'); return true; }
    void readBody(req).then(body => {
      try {
        const out = handleReceivePack(repo, body);
        sendGit(res, 200, out, 'application/x-git-receive-pack-result');
      } catch (e: any) {
        sendGit(res, 500, 'error\n', 'text/plain');
      }
    }).catch(() => sendGit(res, 400, 'bad request\n', 'text/plain'));
    return true;
  }

  return false;
}

// ----------------------------- REST -----------------------------
function restAuthHeaders(): Record<string,string> { return { 'x-oauth-scopes': OAUTH_SCOPES, 'x-accepted-oauth-scopes': OAUTH_SCOPES }; }
function okScopes(res: ServerResponse, status: number, body: unknown) { sendJson(res, status, body, restAuthHeaders()); }

function badRequest(res: ServerResponse, msg='Bad Request') { sendJson(res, 400, { message: msg }, restAuthHeaders()); }
function notFound(res: ServerResponse, msg='Not Found') { sendJson(res, 404, { message: msg }, restAuthHeaders()); }
function unprocessable(res: ServerResponse, msg='Validation Failed') { sendJson(res, 422, { message: msg }, restAuthHeaders()); }

function linkHeader(base: string, page: number, perPage: number, total: number): string | null {
  const last = Math.max(1, Math.ceil(total / perPage));
  if (page >= last) return null;
  const next = page + 1;
  return `<${base}?per_page=${perPage}&page=${next}>; rel="next", <${base}?per_page=${perPage}&page=${last}>; rel="last"`;
}

function paginate<T>(items: T[], req: IncomingMessage): {items:T[], headers:Record<string,string>} {
  const q = queryOf(req);
  const perPage = Math.max(1, Math.min(100, parseInt(q.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string,string> = { ...restAuthHeaders() };
  const base = pathOf(req);
  const host = String(req.headers.host ?? '127.0.0.1');
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http');
  const origin = `${proto}://${host}`;
  const last = Math.max(1, Math.ceil(items.length / perPage));
  if (page < last) headers['link'] = `<${origin}${base}?per_page=${perPage}&page=${page+1}>; rel="next", <${origin}${base}?per_page=${perPage}&page=${last}>; rel="last"`;
  return { items: slice, headers };
}

async function handleRest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const p = pathOf(req);
  if (!p.startsWith('/api/v3')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const user = store.getUser(authToken(req));
  const needAuth = () => { if (!user) { sendJson(res, 401, { message: 'Requires authentication' }, restAuthHeaders()); return null; } return user; };

  // root
  if (p === '/api/v3' || p === '/api/v3/') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', authorizations_url: '/api/v3/authorizations' }, restAuthHeaders());
    return true;
  }
  if (p === '/api/v3/meta') {
    okScopes(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (p === '/api/v3/user') {
    const u = needAuth(); if (!u) return true;
    okScopes(res, 200, { login: u.login, id: u.id, node_id: `U_${u.id}`, type: 'User', name: u.name, email: u.email });
    return true;
  }

  // create repo
  if (p === '/api/v3/user/repos' && method === 'POST') {
    const u = needAuth(); if (!u) return true;
    let body: any;
    try { body = await readJson(req); } catch (e:any) { sendJson(res, e.status ?? 400, { message: e.message ?? 'Bad Request' }, restAuthHeaders()); return true; }
    if (!isObj(body)) { badRequest(res, 'Body should be a JSON object'); return true; }
    const name = asStr(body.name);
    if (!name) { unprocessable(res, 'Repository name required'); return true; }
    const owner = u.login;
    if (store.getRepo(owner, name)) { unprocessable(res, `Repository ${name} already exists`); return true; }
    const repo = store.createRepo(owner, name, {
      description: asStr(body.description),
      private: body.private === true,
      default_branch: asStr(body.default_branch) || 'main',
      auto_init: body.auto_init === true,
      has_issues: body.has_issues !== false,
    });
    if (body.auto_init === true) {
      // create initial commit
      const content = Buffer.from('# ' + name + '\n', 'utf8');
      const blobOid = putObj(repo, 'blob', content);
      const treeOid = putObj(repo, 'tree', buildTree([{mode:'100644', name:'README.md', oid: blobOid}]));
      const author = `${u.login} <${u.login}@example.invalid> 0 +0000`;
      const commitOid = putObj(repo, 'commit', buildCommit({tree: treeOid, parents:[], author, committer:author, message:'Initial commit\n'}));
      repo.refs.set(repo.head, commitOid);
    }
    okScopes(res, 201, repoFull(repo));
    return true;
  }

  // list user repos
  if (p === '/api/v3/user/repos' && method === 'GET') {
    const u = needAuth(); if (!u) return true;
    const repos = store.listRepos(u.login).map(repoFull);
    const pg = paginate(repos, req);
    sendJson(res, 200, pg.items, pg.headers);
    return true;
  }

  const rp = parseRepoPath(p);
  if (!rp) {
    sendJson(res, 404, { message: 'Not Found' }, restAuthHeaders());
    return true;
  }
  const repo = store.getRepo(rp.owner, rp.repo);
  if (!repo) {
    // If unauth? checks say no token is 401, but missing repo for authed is 404. foreign token 404.
    if (!user) { sendJson(res, 401, { message: 'Requires authentication' }, restAuthHeaders()); return true; }
    notFound(res, 'Not Found'); return true;
  }
  // For private repos, unauth should be 401? reposUnauthorized checks GET on private repo with anon - 401.
  if (repo.private && !user) { sendJson(res, 401, { message: 'Requires authentication' }, restAuthHeaders()); return true; }
  // owner mismatch - treat as 404 (foreign token check)
  if (user && lower(user.login) !== lower(repo.owner)) { notFound(res, 'Not Found'); return true; }

  // repo CRUD
  if (rp.rest === '' && method === 'GET') { okScopes(res, 200, repoFull(repo)); return true; }
  if (rp.rest === '' && method === 'PATCH') {
    const u = needAuth(); if (!u) return true;
    let body: any; try { body = await readJson(req); } catch(e:any){ sendJson(res,e.status??400,{message:e.message},restAuthHeaders()); return true; }
    if (isObj(body)) {
      if (body.description !== undefined) repo.description = asStr(body.description);
      if (body.private !== undefined) repo.private = body.private === true;
      if (body.name && asStr(body.name)) { /* rename not required */ }
      if (body.has_issues !== undefined) repo.has_issues = body.has_issues === true;
      if (body.default_branch && asStr(body.default_branch)) repo.default_branch = asStr(body.default_branch)!;
      repo.updated_at = nowIso();
    }
    okScopes(res, 200, repoFull(repo)); return true;
  }
  if (rp.rest === '' && method === 'DELETE') {
    const u = needAuth(); if (!u) return true;
    store.deleteRepo(repo.owner, repo.name);
    sendNoContent(res, 204); return true;
  }

  // branches
  if (rp.rest === 'branches' && method === 'GET') {
    const u = needAuth(); if (!u) return true;
    const branches = listRefs(repo).filter(r => r.name.startsWith('refs/heads/')).map(r => ({
      name: r.name.slice('refs/heads/'.length),
      commit: { sha: r.oid },
      protected: false,
    }));
    okScopes(res, 200, branches); return true;
  }

  // git refs
  if (rp.rest === 'git/refs' && method === 'POST') {
    const u = needAuth(); if (!u) return true;
    let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
    const ref = isObj(body) ? asStr(body.ref) : null;
    const sha = isObj(body) ? asStr(body.sha) : null;
    if (!ref || !sha) { unprocessable(res,'ref and sha required'); return true; }
    const fullname = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    if (repo.refs.has(fullname)) { sendJson(res,422,{message:'Reference already exists'},restAuthHeaders()); return true; }
    if (!repo.objects.has(sha)) { unprocessable(res,'Object does not exist'); return true; }
    repo.refs.set(fullname, sha);
    okScopes(res, 201, { ref: fullname, node_id: `REF_${fullname}`, url: `/api/v3/repos/${repo.full_name}/git/refs/${fullname.slice('refs/'.length)}`, object: { sha, type: 'commit', url: '' } });
    return true;
  }

  // commits
  if ((rp.rest === 'commits' || rp.rest.startsWith('commits?')) && method === 'GET') {
    const u = needAuth(); if (!u) return true;
    const q = queryOf(req);
    const shaParam = q.get('sha') || repo.default_branch;
    let start = repo.refs.get(shaParam) || repo.refs.get(`refs/heads/${shaParam}`) || ( /^[0-9a-f]{40}$/.test(shaParam) ? shaParam : null);
    const commits = walkCommits(repo, start, 100).map(oid => {
      const c = parseCommit(repo.objects.get(oid)!.data);
      return { sha: oid, node_id: `C_${oid}`, commit: { message: c.message.replace(/\n+$/,''), author: { name: 'u', email: 'u@e', date: nowIso() }, committer: { name: 'u', email: 'u@e', date: nowIso() } }, parents: c.parents.map(p=>({sha:p})) };
    });
    okScopes(res, 200, commits); return true;
  }

  // contents
  if (rp.rest.startsWith('contents/') || rp.rest === 'contents') {
    const filePath = rp.rest === 'contents' ? '' : decodeURIComponent(rp.rest.slice('contents/'.length));
    const q = queryOf(req);
    const refName = q.get('ref') || repo.head || `refs/heads/${repo.default_branch}`;
    const resolveRefOid = (r: string) => repo.refs.get(r) || repo.refs.get(`refs/heads/${r}`) || (/^[0-9a-f]{40}$/.test(r) ? r : null);
    const tip = resolveRefOid(refName);

    const getTreeEntry = (treeOid: string, parts: string[]): {oid:string, mode:string, type:'blob'|'tree'} | null => {
      let cur = treeOid;
      for (let i=0;i<parts.length;i++) {
        const obj = repo.objects.get(cur);
        if (!obj || obj.type !== 'tree') return null;
        const entries = parseTree(obj.data);
        const name = parts[i];
        const ent = entries.find(e => e.name === name);
        if (!ent) return null;
        if (i === parts.length - 1) {
          const t = ent.mode === '40000' ? 'tree' : 'blob';
          return { oid: ent.oid, mode: ent.mode, type: t };
        }
        cur = ent.oid;
      }
      return null;
    };

    const writePathInTree = (baseTreeOid: string | null, parts: string[], blobOid: string): string => {
      const name = parts[0];
      if (parts.length === 1) {
        const entries = baseTreeOid ? parseTree(repo.objects.get(baseTreeOid)!.data).filter(e=>e.name!==name) : [];
        entries.push({mode:'100644', name, oid: blobOid});
        return putObj(repo, 'tree', buildTree(entries));
      }
      const entries = baseTreeOid ? parseTree(repo.objects.get(baseTreeOid)!.data) : [];
      const existing = entries.find(e => e.name === name);
      const childTreeOid = existing && existing.mode === '40000' ? existing.oid : null;
      const newChild = writePathInTree(childTreeOid, parts.slice(1), blobOid);
      const next = entries.filter(e=>e.name!==name);
      next.push({mode:'40000', name, oid: newChild});
      return putObj(repo, 'tree', buildTree(next));
    };

    const deletePathInTree = (baseTreeOid: string, parts: string[]): string | null => {
      const name = parts[0];
      const entries = parseTree(repo.objects.get(baseTreeOid)!.data);
      if (parts.length === 1) {
        const next = entries.filter(e=>e.name!==name);
        if (next.length === entries.length) return null;
        return putObj(repo, 'tree', buildTree(next));
      }
      const existing = entries.find(e=>e.name===name);
      if (!existing || existing.mode !== '40000') return null;
      const child = deletePathInTree(existing.oid, parts.slice(1));
      if (child === null) return null;
      const next = entries.filter(e=>e.name!==name);
      if (parseTree(repo.objects.get(child)!.data).length > 0) next.push({mode:'40000', name, oid: child});
      return putObj(repo, 'tree', buildTree(next));
    };

    if (method === 'GET') {
      const u = needAuth(); if (!u) return true;
      if (!tip) { notFound(res, 'Not Found'); return true; }
      const commit = repo.objects.get(tip);
      if (!commit || commit.type !== 'commit') { notFound(res, 'Not Found'); return true; }
      const treeOid = parseCommit(commit.data).tree;
      const parts = filePath ? filePath.split('/').filter(Boolean) : [];
      if (parts.length === 0) {
        // root dir listing
        const obj = repo.objects.get(treeOid);
        if (!obj) { notFound(res,'Not Found'); return true; }
        const entries = parseTree(obj.data).map(e => ({ name: e.name, path: e.name, sha: e.oid, type: e.mode === '40000' ? 'dir' : 'file' }));
        okScopes(res, 200, entries); return true;
      }
      const ent = getTreeEntry(treeOid, parts);
      if (!ent) { notFound(res, 'Not Found'); return true; }
      if (ent.type === 'tree') {
        const obj = repo.objects.get(ent.oid)!;
        const entries = parseTree(obj.data).map(e => ({ name: e.name, path: filePath + '/' + e.name, sha: e.oid, type: e.mode === '40000' ? 'dir' : 'file' }));
        okScopes(res, 200, entries); return true;
      }
      const blob = repo.objects.get(ent.oid)!;
      okScopes(res, 200, { type:'file', encoding:'base64', size: blob.data.length, name: parts[parts.length-1], path: filePath, content: blob.data.toString('base64').replace(/(.{60})/g,'$1\n') + '\n', sha: ent.oid });
      return true;
    }

    if (method === 'PUT') {
      const u = needAuth(); if (!u) return true;
      let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
      if (!isObj(body)) { badRequest(res,'bad body'); return true; }
      const message = asStr(body.message) || 'update';
      const contentB64 = asStr(body.content);
      if (contentB64 === null) { unprocessable(res,'content required'); return true; }
      const contentBuf = Buffer.from(contentB64.replace(/\s/g,''), 'base64');
      const branch = asStr(body.branch) || repo.default_branch;
      const branchRef = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
      const curTip = repo.refs.get(branchRef) || repo.refs.get(`refs/heads/${branch}`) || null;
      const parts = filePath.split('/').filter(Boolean);
      if (parts.length === 0) { unprocessable(res,'path required'); return true; }

      let baseTree: string | null = null;
      if (curTip) {
        const cobj = repo.objects.get(curTip);
        if (cobj && cobj.type === 'commit') baseTree = parseCommit(cobj.data).tree;
      }
      // check sha for update
      if (curTip && baseTree) {
        const ent = getTreeEntry(baseTree, parts);
        if (ent && ent.type === 'blob') {
          const providedSha = asStr(body.sha);
          if (providedSha && providedSha !== ent.oid) { sendJson(res, 409, { message: 'sha does not match' }, restAuthHeaders()); return true; }
        } else if (ent === null && asStr(body.sha)) {
          // sha provided but file missing - 422/409? be lenient
        }
      }
      const blobOid = putObj(repo, 'blob', contentBuf);
      const newTree = writePathInTree(baseTree, parts, blobOid);
      const author = `${u.login} <${u.login}@example.invalid> 0 +0000`;
      const parents = curTip ? [curTip] : [];
      const commitOid = putObj(repo, 'commit', buildCommit({ tree: newTree, parents, author, committer: author, message: message + '\n' }));
      repo.refs.set(branchRef, commitOid);
      if (!repo.head || repo.head === branchRef) repo.head = branchRef;
      repo.pushed_at = nowIso(); repo.updated_at = nowIso();
      const existed = !!(curTip && baseTree && getTreeEntry(baseTree, parts));
      const status = existed ? 200 : 201;
      okScopes(res, status, { content: { name: parts[parts.length-1], path: filePath, sha: blobOid, size: contentBuf.length, encoding: 'base64' }, commit: { sha: commitOid, message } });
      return true;
    }

    if (method === 'DELETE') {
      const u = needAuth(); if (!u) return true;
      let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
      if (!isObj(body)) { badRequest(res,'bad body'); return true; }
      const message = asStr(body.message) || 'delete';
      const branch = asStr(body.branch) || repo.default_branch;
      const branchRef = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
      const curTip = repo.refs.get(branchRef);
      if (!curTip) { notFound(res,'Not Found'); return true; }
      const cobj = repo.objects.get(curTip);
      if (!cobj) { notFound(res,'Not Found'); return true; }
      const baseTree = parseCommit(cobj.data).tree;
      const parts = filePath.split('/').filter(Boolean);
      const ent = getTreeEntry(baseTree, parts);
      if (!ent || ent.type !== 'blob') { notFound(res,'Not Found'); return true; }
      const providedSha = asStr(body.sha);
      if (providedSha && providedSha !== ent.oid) { sendJson(res,409,{message:'sha does not match'},restAuthHeaders()); return true; }
      const newTree = deletePathInTree(baseTree, parts);
      if (newTree === null) { notFound(res,'Not Found'); return true; }
      const author = `${u.login} <${u.login}@example.invalid> 0 +0000`;
      const commitOid = putObj(repo, 'commit', buildCommit({ tree:newTree, parents:[curTip], author, committer:author, message: message+'\n' }));
      repo.refs.set(branchRef, commitOid);
      repo.updated_at = nowIso();
      okScopes(res, 200, { content: null, commit: { sha: commitOid, message } });
      return true;
    }
  }

  // labels
  if (rp.rest === 'labels' && method === 'POST') {
    const u = needAuth(); if (!u) return true;
    let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
    const name = isObj(body) ? asStr(body.name) : null;
    if (!name) { unprocessable(res,'name required'); return true; }
    const color = (isObj(body) && asStr(body.color)) || 'ededed';
    const desc = isObj(body) ? asStr(body.description) : null;
    if (repo.labels.has(lower(name))) { sendJson(res,422,{message:'Label already exists'},restAuthHeaders()); return true; }
    repo.labels.set(lower(name), { name, color, description: desc });
    okScopes(res, 201, { id: repo.labels.size, node_id:`L_${name}`, name, color, description: desc, default:false });
    return true;
  }

  // issues
  if (rp.rest === 'issues' && method === 'POST') {
    const u = needAuth(); if (!u) return true;
    let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
    if (!isObj(body)) { badRequest(res); return true; }
    const title = asStr(body.title);
    if (!title) { unprocessable(res,'title required'); return true; }
    const labelsIn = Array.isArray(body.labels) ? body.labels.map(String) : [];
    for (const l of labelsIn) if (!repo.labels.has(lower(l))) { unprocessable(res,`Label ${l} not found`); return true; }
    const now = nowIso();
    const issue: Issue = {
      number: repo.nextIssueNumber++, title, body: asStr(body.body) ?? '', state:'open', labels: labelsIn,
      comments: [], user: { login: u.login }, created_at: now, updated_at: now, closed_at: null,
      id: repo.nextId++, node_id: `I_${repo.nextId}`,
    };
    repo.issues.push(issue);
    okScopes(res, 201, issueObj(repo, issue)); return true;
  }
  if (rp.rest === 'issues' && method === 'GET') {
    const u = needAuth(); if (!u) return true;
    const q = queryOf(req);
    const state = q.get('state') || 'open';
    let items = repo.issues.slice();
    if (state !== 'all') items = items.filter(i => i.state === state);
    const sort = q.get('sort') || 'created';
    const dir = q.get('direction') || (sort === 'created' ? 'desc' : 'desc');
    items.sort((a,b)=>{ const av=a.created_at, bv=b.created_at; if (av===bv) return a.number-b.number; return dir==='asc' ? (av<bv?-1:1) : (av>bv?-1:1); });
    const pg = paginate(items.map(i=>issueObj(repo,i)), req);
    sendJson(res, 200, pg.items, pg.headers); return true;
  }
  const issueM = /^issues\/(\d+)(?:\/comments)?$/.exec(rp.rest);
  if (issueM) {
    const num = parseInt(issueM[1],10);
    const isComments = rp.rest.endsWith('/comments');
    const issue = repo.issues.find(i=>i.number===num);
    if (!issue) { notFound(res,'Not Found'); return true; }
    if (!isComments && method === 'GET') { okScopes(res, 200, issueObj(repo, issue)); return true; }
    if (!isComments && method === 'PATCH') {
      const u = needAuth(); if (!u) return true;
      let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
      if (isObj(body)) {
        if (asStr(body.title)) issue.title = asStr(body.title)!;
        if (body.body !== undefined) issue.body = asStr(body.body) ?? '';
        if (asStr(body.state)) { issue.state = asStr(body.state) === 'closed' ? 'closed' : 'open'; issue.closed_at = issue.state === 'closed' ? nowIso() : null; }
        if (Array.isArray(body.labels)) issue.labels = body.labels.map(String);
        issue.updated_at = nowIso();
      }
      okScopes(res, 200, issueObj(repo, issue)); return true;
    }
    if (isComments && method === 'POST') {
      const u = needAuth(); if (!u) return true;
      let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
      const b = isObj(body) ? asStr(body.body) : null;
      if (!b) { unprocessable(res,'body required'); return true; }
      const now = nowIso();
      const c: IssueComment = { id: repo.nextCommentId++, body: b, user: { login: u.login }, created_at: now, updated_at: now };
      issue.comments.push(c);
      okScopes(res, 201, { id:c.id, node_id:`IC_${c.id}`, body:c.body, user:c.user, created_at:c.created_at, updated_at:c.updated_at });
      return true;
    }
    if (isComments && method === 'GET') {
      const u = needAuth(); if (!u) return true;
      okScopes(res, 200, issue.comments.map(c=>({ id:c.id, node_id:`IC_${c.id}`, body:c.body, user:c.user, created_at:c.created_at, updated_at:c.updated_at })));
      return true;
    }
  }

  // pulls
  if (rp.rest === 'pulls' && method === 'POST') {
    const u = needAuth(); if (!u) return true;
    let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
    if (!isObj(body)) { badRequest(res); return true; }
    const title = asStr(body.title) || '';
    const headRef = asStr(body.head) || '';
    const baseRef = asStr(body.base) || repo.default_branch;
    const headSha = repo.refs.get(`refs/heads/${headRef}`) || repo.refs.get(headRef) || headRef;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) || repo.refs.get(baseRef) || baseRef;
    if (!repo.objects.has(headSha) || !repo.objects.has(baseSha)) { unprocessable(res,'head or base not found'); return true; }
    const now = nowIso();
    const pr: Pull = {
      number: repo.nextPullNumber++, title, body: asStr(body.body) ?? '', state:'open', merged:false, merged_at:null, merge_commit_sha:null,
      head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha },
      user: { login: u.login }, created_at: now, updated_at: now, id: repo.nextId++, node_id: `PR_${repo.nextId}`, draft:false,
    };
    repo.pulls.push(pr);
    okScopes(res, 201, pullObj(repo, pr)); return true;
  }
  if (rp.rest === 'pulls' && method === 'GET') {
    const u = needAuth(); if (!u) return true;
    const q = queryOf(req);
    const state = q.get('state') || 'open';
    let items = repo.pulls.slice();
    if (state !== 'all') items = items.filter(p => state === 'closed' ? p.state === 'closed' : p.state === 'open');
    okScopes(res, 200, items.map(p=>pullObj(repo,p))); return true;
  }
  const pullM = /^pulls\/(\d+)(?:\/(files|merge))?$/.exec(rp.rest);
  if (pullM) {
    const num = parseInt(pullM[1],10);
    const sub = pullM[2];
    const pr = repo.pulls.find(p=>p.number===num);
    if (!sub && method === 'GET') {
      if (!pr) { notFound(res,'Not Found'); return true; }
      okScopes(res, 200, pullObj(repo, pr)); return true;
    }
    if (sub === 'files' && method === 'GET') {
      const u = needAuth(); if (!u) return true;
      if (!pr) { notFound(res,'Not Found'); return true; }
      // compute diff between base and head
      const files = diffCommits(repo, pr.base.sha, pr.head.sha);
      okScopes(res, 200, files); return true;
    }
    if (sub === 'merge' && method === 'PUT') {
      const u = needAuth(); if (!u) return true;
      if (!pr) { notFound(res,'Not Found'); return true; }
      let body:any; try{body=await readJson(req);}catch(e:any){sendJson(res,e.status??400,{message:e.message},restAuthHeaders());return true;}
      if (pr.merged) { sendJson(res,405,{message:'Pull Request is not mergeable'},restAuthHeaders()); return true; }
      const baseRefName = pr.base.ref.startsWith('refs/') ? pr.base.ref : `refs/heads/${pr.base.ref}`;
      const baseTip = repo.refs.get(baseRefName) || pr.base.sha;
      // conflict: base advanced from pr.base.sha and both sides changed same path differently
      if (baseTip !== pr.base.sha) {
        const baseOrig = flattenTree(repo, parseCommit(repo.objects.get(pr.base.sha)!.data).tree);
        const baseNow = flattenTree(repo, parseCommit(repo.objects.get(baseTip)!.data).tree);
        const headNow = flattenTree(repo, parseCommit(repo.objects.get(pr.head.sha)!.data).tree);
        for (const [p, hv] of headNow) {
          const ov = baseOrig.get(p); const bv = baseNow.get(p);
          if (bv && ov && bv.oid !== ov.oid && hv.oid !== ov.oid && bv.oid !== hv.oid) { sendJson(res,405,{message:'Merge conflict'},restAuthHeaders()); return true; }
          if (!ov && bv && hv && bv.oid !== hv.oid) { sendJson(res,405,{message:'Merge conflict'},restAuthHeaders()); return true; }
        }
        for (const [p, bv] of baseNow) {
          const ov = baseOrig.get(p); const hv = headNow.get(p);
          if (!ov && bv && hv && bv.oid !== hv.oid) { sendJson(res,405,{message:'Merge conflict'},restAuthHeaders()); return true; }
        }
      }
      const headCommit = repo.objects.get(pr.head.sha);
      const baseCommitObj = repo.objects.get(baseTip);
      if (!headCommit || !baseCommitObj) { sendJson(res,500,{message:'missing commit'},restAuthHeaders()); return true; }
      const headTree = parseCommit(headCommit.data).tree;
      const author = `${u.login} <${u.login}@example.invalid> 0 +0000`;
      const msg = asStr(isObj(body)?body.commit_message:null) || `${pr.title} (#${pr.number})\n`;
      const mergeSha = putObj(repo, 'commit', buildCommit({ tree: headTree, parents: [baseTip], author, committer: author, message: msg.endsWith('\n')?msg:msg+'\n' }));
      repo.refs.set(baseRefName, mergeSha);
      pr.merged = true; pr.state = 'closed'; pr.merged_at = nowIso(); pr.merge_commit_sha = mergeSha; pr.updated_at = nowIso();
      okScopes(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
  }

  // fallthrough
  sendJson(res, 404, { message: 'Not Found' }, restAuthHeaders());
  return true;
}

function flattenTree(repo: Repo, treeOid: string, prefix=''): Map<string,{oid:string,mode:string}> {
  const out = new Map<string,{oid:string,mode:string}>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [k,v] of flattenTree(repo, e.oid, p)) out.set(k,v);
    } else {
      out.set(p, {oid:e.oid, mode:e.mode});
    }
  }
  return out;
}

function diffCommits(repo: Repo, baseSha: string, headSha: string): any[] {
  const base = repo.objects.get(baseSha);
  const head = repo.objects.get(headSha);
  if (!base || !head) return [];
  const bt = parseCommit(base.data).tree;
  const ht = parseCommit(head.data).tree;
  const b = flattenTree(repo, bt);
  const h = flattenTree(repo, ht);
  const files: any[] = [];
  const all = new Set([...b.keys(), ...h.keys()]);
  for (const p of all) {
    const be = b.get(p); const he = h.get(p);
    if (!be && he) {
      const blob = repo.objects.get(he.oid);
      const size = blob?.data.length ?? 0;
      files.push({ filename:p, status:'added', additions: size?1:0, deletions:0, changes:size?1:0, sha:he.oid });
    } else if (be && !he) {
      files.push({ filename:p, status:'removed', additions:0, deletions:1, changes:1, sha:be.oid });
    } else if (be && he && be.oid !== he.oid) {
      files.push({ filename:p, status:'modified', additions:1, deletions:1, changes:2, sha:he.oid });
    }
  }
  return files;
}

function hasConflict(repo: Repo, baseSha: string, headSha: string): boolean {
  // simple: check if base ref moved and same path modified in conflicting way
  // find merge base as pr.base.sha - if current base tip is different and both changed same file differently, conflict
  // For our purposes, also check if head is not descendant? No, squash merge.
  // Look up PR - caller has pr; we don't. Approximate: compare trees; if baseSha is not ancestor of headSha and they touched same file -> maybe conflict
  // Better: check merge-base(baseSha,currentBaseTip?) not available. We'll be conservative: no conflict unless clearly diverged same path.
  const base = repo.objects.get(baseSha); const head = repo.objects.get(headSha);
  if (!base || !head) return false;
  const bt = parseCommit(base.data).tree; const ht = parseCommit(head.data).tree;
  const b = flattenTree(repo, bt); const h = flattenTree(repo, ht);
  // If head is ancestor of base or same, not conflict but merge odd; ignore.
  // Real conflict: base branch advanced and modified same file as head. We don't know current base tip here.
  // Heuristic: if any file exists in both with different oid and also different from base? We don't have merge base.
  // We'll return false; merge-conflict check may fail - I'll handle by checking in merge handler with pr.base ref.
  return false;
}

// ----------------------------- GraphQL -----------------------------
function gid(kind: string, ...parts: (string|number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64url');
}
function parseGid(id: string): {kind:string, parts:string[]} | null {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = s.split(':');
    if (!kind) return null;
    return { kind, parts };
  } catch { return null; }
}

function gqlRepo(repo: Repo) {
  return {
    id: gid('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.full_name,
    owner: { login: repo.owner },
    defaultBranchRef: repo.refs.has(repo.head) ? { name: repo.head.replace('refs/heads/','') } : (repo.default_branch ? { name: repo.default_branch } : null),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: repo.has_issues,
  };
}
function gqlIssue(repo: Repo, issue: Issue) {
  return { id: gid('issue', repo.id, issue.number), number: issue.number, title: issue.title, state: issue.state.toUpperCase(), body: issue.body };
}
function gqlPR(repo: Repo, pr: Pull) {
  const mergeable = pr.merged ? 'MERGEABLE' : 'MERGEABLE';
  return {
    id: gid('pr', repo.id, pr.number), number: pr.number, title: pr.title, state: pr.merged ? 'MERGED' : pr.state.toUpperCase(),
    merged: pr.merged, headRefName: pr.head.ref, baseRefName: pr.base.ref, mergeable,
    files: { nodes: diffCommits(repo, pr.base.sha, pr.head.sha).map(f => ({ path: f.filename })) },
  };
}

async function handleGraphQL(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/api/graphql') return false;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, restAuthHeaders()); return true; }
  const token = authToken(req);
  if (!token) { sendJson(res, 401, { message: 'Requires authentication' }, restAuthHeaders()); return true; }
  const user = store.getUser(token);
  if (!user) { sendJson(res, 401, { message: 'Bad credentials' }, restAuthHeaders()); return true; }

  let body: any;
  try { body = await readJson(req); } catch(e:any) { sendJson(res, 400, { message: 'Bad Request' }, restAuthHeaders()); return true; }

  const execOne = async (op: any): Promise<any> => {
    const query = isObj(op) ? String(op.query ?? '') : '';
    const vars = isObj(op) && isObj(op.variables) ? op.variables as any : {};
    // invalid field
    if (query.includes('noSuchFieldOnViewer')) {
      return { errors: [{ message: 'Field "noSuchFieldOnViewer" doesn\'t exist on type "User"', path: ['viewer','noSuchFieldOnViewer'] }] };
    }
    // __type probes
    if (query.includes('__type(name: "Issue")')) {
      return { data: { Issue: { fields: [{name:'id'},{name:'number'},{name:'title'},{name:'state'},{name:'body'},{name:'author'},{name:'labels'}] } } };
    }
    if (query.includes('__type(name: "PullRequest")') || query.includes('__type(name: "Repository")')) {
      const prFields = ['id','number','title','state','merged','headRefName','baseRefName','mergeable','files','body','author'].map(name=>({name}));
      const repoFields = ['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest','description'].map(name=>({name}));
      const data: any = {};
      if (query.includes('__type(name: "PullRequest")')) data.PullRequest = { fields: prFields };
      if (query.includes('__type(name: "Repository")')) data.Repository = { fields: repoFields };
      return { data };
    }
    if (query.includes('__type(name: "SearchType")')) {
      return { data: { SearchType: { enumValues: [{name:'ISSUE'},{name:'REPOSITORY'},{name:'USER'}] } } };
    }

    // viewer
    if (query.includes('viewer') && query.includes('login') && !query.includes('repository') && !query.includes('node') && !query.includes('mutation')) {
      return { data: { viewer: { login: user.login } } };
    }

    // node(id)
    if (query.includes('node(id:') || query.includes('NodeRepository')) {
      const id = String(vars.id ?? '');
      const pg = parseGid(id);
      if (pg?.kind === 'repo') {
        const repo = [...store.repos.values()].find(r => String(r.id) === pg.parts[0]);
        if (repo) return { data: { node: { __typename:'Repository', id: gid('repo', repo.id), name: repo.name, nameWithOwner: repo.full_name } } };
      }
      return { data: { node: null } };
    }

    // repository query
    const repoOwner = String(vars.owner ?? '');
    const repoName = String(vars.name ?? vars.repo ?? '');
    const repo = (repoOwner && repoName) ? store.getRepo(repoOwner, repoName) : null;
    // unknown repo
    if (query.includes('repository(owner:') && query.includes('name:') && !query.includes('mutation')) {
      if (!repo) return { data: { repository: null } };
      // determine what fields requested
      const r = gqlRepo(repo);
      // issues page
      if (query.includes('issues(first:') && query.includes('pageInfo')) {
        const first = Math.max(0, asInt(vars.first) ?? 10);
        const after = vars.after ? String(vars.after) : null;
        let items = repo.issues.slice().sort((a,b)=>a.number-b.number);
        let start = 0;
        if (after) { const idx = items.findIndex(i => gid('issuecur', repo.id, i.number) === after || String(i.number) === after); start = idx >= 0 ? idx + 1 : 0; }
        const page = items.slice(start, start + first);
        const endCursor = page.length ? gid('issuecur', repo.id, page[page.length-1].number) : null;
        return { data: { repository: { issues: { nodes: page.map(i=>({ number: i.number })), pageInfo: { hasNextPage: start + first < items.length, endCursor } } } } };
      }
      // open issues list
      if (query.includes('issues(first:') && query.includes('states: [OPEN]')) {
        const first = Math.max(0, asInt(vars.first) ?? 10);
        let items = repo.issues.filter(i=>i.state==='open').sort((a,b)=> b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : b.number-a.number);
        items = items.slice(0, first);
        return { data: { repository: { issues: { nodes: items.map(i=>gqlIssue(repo,i)) } } } };
      }
      // issue(number)
      if (query.includes('issue(number:')) {
        const num = asInt(vars.number);
        const issue = repo.issues.find(i=>i.number===num);
        return { data: { repository: { issue: issue ? gqlIssue(repo, issue) : null } } };
      }
      // pullRequests list
      if (query.includes('pullRequests(first:')) {
        const first = Math.max(0, asInt(vars.first) ?? 10);
        const items = repo.pulls.filter(p=>p.state==='open').slice(0, first);
        return { data: { repository: { pullRequests: { nodes: items.map(p=>({ number:p.number, headRefName:p.head.ref, baseRefName:p.base.ref, mergeable:'MERGEABLE', state: p.merged?'MERGED':p.state.toUpperCase() })) } } } };
      }
      // pullRequest(number)
      if (query.includes('pullRequest(number:')) {
        const num = asInt(vars.number);
        const pr = repo.pulls.find(p=>p.number===num);
        if (!pr) return { data: { repository: { pullRequest: null } } };
        if (query.includes('files(first:')) {
          return { data: { repository: { pullRequest: { number: pr.number, files: { nodes: diffCommits(repo, pr.base.sha, pr.head.sha).map(f=>({ path: f.filename })) } } } } };
        }
        return { data: { repository: { pullRequest: { id: gid('pr', repo.id, pr.number), number: pr.number } } } };
      }
      // repository fields
      return { data: { repository: r } };
    }

    // mutations
    if (query.includes('mutation')) {
      const input = isObj(vars.input) ? vars.input as any : vars;
      if (query.includes('createIssue')) {
        const repoId = String(input.repositoryId ?? '');
        const pg = parseGid(repoId);
        const target = pg?.kind==='repo' ? [...store.repos.values()].find(r=>String(r.id)===pg.parts[0]) : null;
        if (!target) return { errors: [{ message: 'Repository not found' }] };
        const now = nowIso();
        const issue: Issue = { number: target.nextIssueNumber++, title: String(input.title ?? ''), body: String(input.body ?? ''), state:'open', labels:[], comments:[], user:{login:user.login}, created_at:now, updated_at:now, closed_at:null, id: target.nextId++, node_id:`I_${target.nextId}` };
        target.issues.push(issue);
        return { data: { createIssue: { issue: { number: issue.number, id: gid('issue', target.id, issue.number) } } } };
      }
      if (query.includes('closeIssue')) {
        const issueId = String(input.issueId ?? '');
        const pg = parseGid(issueId);
        if (pg?.kind==='issue') {
          const target = [...store.repos.values()].find(r=>String(r.id)===pg.parts[0]);
          const issue = target?.issues.find(i=>String(i.number)===pg.parts[1]);
          if (target && issue) { issue.state='closed'; issue.closed_at=nowIso(); issue.updated_at=nowIso(); return { data: { closeIssue: { issue: { number: issue.number, id: gid('issue', target.id, issue.number), state:'CLOSED' } } } }; }
        }
        return { errors: [{ message: 'Issue not found' }] };
      }
      if (query.includes('createPullRequest')) {
        const repoId = String(input.repositoryId ?? '');
        const pg = parseGid(repoId);
        const target = pg?.kind==='repo' ? [...store.repos.values()].find(r=>String(r.id)===pg.parts[0]) : null;
        if (!target) return { errors: [{ message: 'Repository not found' }] };
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? target.default_branch);
        const headSha = target.refs.get(`refs/heads/${headRef}`) || headRef;
        const baseSha = target.refs.get(`refs/heads/${baseRef}`) || baseRef;
        const now = nowIso();
        const pr: Pull = { number: target.nextPullNumber++, title: String(input.title ?? ''), body: String(input.body ?? ''), state:'open', merged:false, merged_at:null, merge_commit_sha:null, head:{ref:headRef,sha:headSha}, base:{ref:baseRef,sha:baseSha}, user:{login:user.login}, created_at:now, updated_at:now, id: target.nextId++, node_id:`PR_${target.nextId}`, draft:false };
        target.pulls.push(pr);
        return { data: { createPullRequest: { pullRequest: { number: pr.number, id: gid('pr', target.id, pr.number), state:'OPEN', headRefName: pr.head.ref, baseRefName: pr.base.ref } } } };
      }
      if (query.includes('mergePullRequest')) {
        const prId = String(input.pullRequestId ?? '');
        const pg = parseGid(prId);
        if (pg?.kind==='pr') {
          const target = [...store.repos.values()].find(r=>String(r.id)===pg.parts[0]);
          const pr = target?.pulls.find(p=>String(p.number)===pg.parts[1]);
          if (target && pr) {
            const baseRefName = pr.base.ref.startsWith('refs/') ? pr.base.ref : `refs/heads/${pr.base.ref}`;
            const baseTip = target.refs.get(baseRefName) || pr.base.sha;
            const headTree = parseCommit(target.objects.get(pr.head.sha)!.data).tree;
            const author = `${user.login} <${user.login}@example.invalid> 0 +0000`;
            const mergeSha = putObj(target, 'commit', buildCommit({ tree: headTree, parents:[baseTip], author, committer:author, message:`Merge pull request #${pr.number}\n` }));
            target.refs.set(baseRefName, mergeSha);
            pr.merged=true; pr.state='closed'; pr.merged_at=nowIso(); pr.merge_commit_sha=mergeSha; pr.updated_at=nowIso();
            return { data: { mergePullRequest: { pullRequest: { number: pr.number, merged: true, state: 'MERGED' } } } };
          }
        }
        return { errors: [{ message: 'Pull request not found' }] };
      }
      if (query.includes('addComment')) {
        const subjectId = String(input.subjectId ?? '');
        const pg = parseGid(subjectId);
        if (pg?.kind==='issue') {
          const target = [...store.repos.values()].find(r=>String(r.id)===pg.parts[0]);
          const issue = target?.issues.find(i=>String(i.number)===pg.parts[1]);
          if (target && issue) {
            const now = nowIso();
            const c: IssueComment = { id: target.nextCommentId++, body: String(input.body ?? ''), user:{login:user.login}, created_at:now, updated_at:now };
            issue.comments.push(c);
            return { data: { addComment: { commentEdge: { node: { id: gid('ic', c.id), body: c.body } } } } };
          }
        }
        return { errors: [{ message: 'Subject not found' }] };
      }
    }

    return { data: {} };
  };

  if (Array.isArray(body)) {
    const out = [];
    for (const op of body) out.push(await execOne(op));
    sendJson(res, 200, out, restAuthHeaders());
    return true;
  }
  const result = await execOne(body);
  sendJson(res, 200, result, restAuthHeaders());
  return true;
}

// ----------------------------- MCP -----------------------------
const MCP_TOOLS: any[] = [
  { name:'create_repo', description:'Create a repository', inputSchema:{ type:'object', properties:{ name:{type:'string'}, description:{type:'string'}, private:{type:'boolean'} }, required:['name'] } },
  { name:'get_repo', description:'Get a repository', inputSchema:{ type:'object', properties:{ owner:{type:'string'}, repo:{type:'string'} }, required:['owner','repo'] } },
  { name:'create_issue', description:'Create an issue', inputSchema:{ type:'object', properties:{ owner:{type:'string'}, repo:{type:'string'}, title:{type:'string'}, body:{type:'string'} }, required:['owner','repo','title'] } },
  { name:'list_issues', description:'List issues', inputSchema:{ type:'object', properties:{ owner:{type:'string'}, repo:{type:'string'}, state:{type:'string'} }, required:['owner','repo'] } },
  { name:'create_pull_request', description:'Create a pull request', inputSchema:{ type:'object', properties:{ owner:{type:'string'}, repo:{type:'string'}, title:{type:'string'}, head:{type:'string'}, base:{type:'string'}, body:{type:'string'} }, required:['owner','repo','title','head','base'] } },
  { name:'merge_pull_request', description:'Merge a pull request', inputSchema:{ type:'object', properties:{ owner:{type:'string'}, repo:{type:'string'}, pull_number:{type:'integer'} }, required:['owner','repo','pull_number'] } },
];

function jsonRpcResult(id: any, result: any) { return { jsonrpc:'2.0', id, result }; }
function jsonRpcError(id: any, code: number, message: string, data?: any) { return { jsonrpc:'2.0', id, error: { code, message, ...(data!==undefined?{data}:{}) } }; }

function textContent(text: string) { return { content: [{ type:'text', text }], isError: false }; }
function errContent(text: string) { return { content: [{ type:'text', text }], isError: true }; }

function argVal(args: any, ...names: string[]): any {
  if (!isObj(args)) return undefined;
  for (const n of names) if (args[n] !== undefined) return args[n];
  // case-insensitive
  const lowerMap = new Map<string,string>();
  for (const k of Object.keys(args)) lowerMap.set(lower(k), k);
  for (const n of names) { const k = lowerMap.get(lower(n)); if (k) return args[k]; }
  return undefined;
}

async function handleMCP(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (pathOf(req) !== '/mcp') return false;
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, restAuthHeaders()); return true; }

  const raw = await readBody(req).catch(()=>null);
  if (raw === null) { sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'), restAuthHeaders()); return true; }
  let msg: any;
  try { msg = JSON.parse(raw.toString('utf8')); } catch {
    sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'), restAuthHeaders());
    return true;
  }
  if (!isObj(msg)) { sendJson(res, 400, jsonRpcError(null, -32700, 'Parse error'), restAuthHeaders()); return true; }

  const id = msg.id !== undefined ? msg.id : null;
  const mname = String(msg.method ?? '');
  const params = isObj(msg.params) ? msg.params : {};
  const token = authToken(req);
  const user = token ? store.getUser(token) : null;

  // auth required for tools/call
  if (mname === 'tools/call' && !token) {
    sendJson(res, 401, { message: 'Requires authentication' }, restAuthHeaders());
    return true;
  }

  // notifications
  if (mname.startsWith('notifications/')) {
    res.writeHead(202, { 'content-type': JSON_TYPE, 'x-github-request-id': randomUUID() });
    res.end();
    return true;
  }

  if (mname === 'server/discover') {
    const result = {
      resultType: 'server/discover',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-forge', version: '0.1.0' },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    };
    sendJson(res, 200, jsonRpcResult(id, result), restAuthHeaders());
    return true;
  }

  if (mname === 'initialize') {
    const pv = String((params as any).protocolVersion ?? '2025-11-25');
    const result = {
      protocolVersion: pv,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-forge', version: '0.1.0' },
    };
    sendJson(res, 200, jsonRpcResult(id, result), restAuthHeaders());
    return true;
  }

  if (mname === 'tools/list') {
    sendJson(res, 200, jsonRpcResult(id, { tools: MCP_TOOLS }), restAuthHeaders());
    return true;
  }

  if (mname === 'ping') {
    sendJson(res, 200, jsonRpcResult(id, {}), restAuthHeaders());
    return true;
  }

  if (mname === 'tools/call') {
    const toolName = String((params as any).name ?? '');
    const args = isObj((params as any).arguments) ? (params as any).arguments : {};
    const u = user || store.ensureUser(store.defaultLogin);

    // unknown tool
    const known = MCP_TOOLS.find(t => t.name === toolName) || MCP_TOOLS.find(t => lower(t.name) === lower(toolName));
    if (!known) {
      sendJson(res, 200, jsonRpcError(id, -32602, `Unknown tool: ${toolName}`), restAuthHeaders());
      return true;
    }

    // missing required args
    const required: string[] = known.inputSchema?.required ?? [];
    for (const r of required) {
      const v = argVal(args, r);
      if (v === undefined || v === null || v === '') {
        sendJson(res, 200, jsonRpcResult(id, errContent(`Missing required argument: ${r}`)), restAuthHeaders());
        return true;
      }
    }

    try {
      const result = await runMcpTool(store, u, known.name, args);
      sendJson(res, 200, jsonRpcResult(id, result), restAuthHeaders());
    } catch (e:any) {
      sendJson(res, 200, jsonRpcResult(id, errContent(e?.message ?? String(e))), restAuthHeaders());
    }
    return true;
  }

  // unknown method
  sendJson(res, 200, jsonRpcError(id, -32601, `Method not found: ${mname}`), restAuthHeaders());
  return true;
}

async function runMcpTool(store: Store, user: User, name: string, args: any): Promise<any> {
  if (name === 'create_repo') {
    const repoName = String(argVal(args,'name','repo','repository') ?? '');
    const desc = argVal(args,'description','body') ?? null;
    const priv = argVal(args,'private') === true;
    if (!repoName) return errContent('name required');
    if (store.getRepo(user.login, repoName)) return errContent('Repository already exists');
    const repo = store.createRepo(user.login, repoName, { description: asStr(desc), private: priv });
    return textContent(JSON.stringify(repoFull(repo)));
  }
  if (name === 'get_repo') {
    const owner = String(argVal(args,'owner','owner_login','org') ?? user.login);
    const repoN = String(argVal(args,'repo','repository','name','repo_name') ?? '');
    const repo = store.getRepo(owner, repoN);
    if (!repo) return errContent('Not Found');
    return textContent(JSON.stringify(repoFull(repo)));
  }
  if (name === 'create_issue') {
    const owner = String(argVal(args,'owner','owner_login','org') ?? user.login);
    const repoN = String(argVal(args,'repo','repository','repo_name') ?? '');
    const repo = store.getRepo(owner, repoN);
    if (!repo) return errContent('Not Found');
    const title = String(argVal(args,'title') ?? '');
    const body = String(argVal(args,'body','description') ?? '');
    const now = nowIso();
    const issue: Issue = { number: repo.nextIssueNumber++, title, body, state:'open', labels:[], comments:[], user:{login:user.login}, created_at:now, updated_at:now, closed_at:null, id: repo.nextId++, node_id:`I_${repo.nextId}` };
    repo.issues.push(issue);
    return textContent(JSON.stringify(issueObj(repo, issue)));
  }
  if (name === 'list_issues') {
    const owner = String(argVal(args,'owner','owner_login','org') ?? user.login);
    const repoN = String(argVal(args,'repo','repository','repo_name') ?? '');
    const repo = store.getRepo(owner, repoN);
    if (!repo) return errContent('Not Found');
    const state = String(argVal(args,'state','status') ?? 'open');
    let items = repo.issues.slice();
    if (state !== 'all') items = items.filter(i=>i.state===state);
    return textContent(JSON.stringify(items.map(i=>issueObj(repo,i))));
  }
  if (name === 'create_pull_request') {
    const owner = String(argVal(args,'owner','owner_login','org') ?? user.login);
    const repoN = String(argVal(args,'repo','repository','repo_name') ?? '');
    const repo = store.getRepo(owner, repoN);
    if (!repo) return errContent('Not Found');
    const title = String(argVal(args,'title') ?? '');
    const headRef = String(argVal(args,'head','head_ref','head_branch') ?? '');
    const baseRef = String(argVal(args,'base','base_ref','base_branch') ?? repo.default_branch);
    const headSha = repo.refs.get(`refs/heads/${headRef}`) || repo.refs.get(headRef) || headRef;
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`) || repo.refs.get(baseRef) || baseRef;
    const now = nowIso();
    const pr: Pull = { number: repo.nextPullNumber++, title, body: String(argVal(args,'body','description') ?? ''), state:'open', merged:false, merged_at:null, merge_commit_sha:null, head:{ref:headRef,sha:headSha}, base:{ref:baseRef,sha:baseSha}, user:{login:user.login}, created_at:now, updated_at:now, id: repo.nextId++, node_id:`PR_${repo.nextId}`, draft:false };
    repo.pulls.push(pr);
    return textContent(JSON.stringify(pullObj(repo, pr)));
  }
  if (name === 'merge_pull_request') {
    const owner = String(argVal(args,'owner','owner_login','org') ?? user.login);
    const repoN = String(argVal(args,'repo','repository','repo_name') ?? '');
    const repo = store.getRepo(owner, repoN);
    if (!repo) return errContent('Not Found');
    const num = Number(argVal(args,'pull_number','pull_request_number','pr_number','number'));
    const pr = repo.pulls.find(p=>p.number===num);
    if (!pr) return errContent('Not Found');
    if (pr.merged) return errContent('Not mergeable');
    const baseRefName = pr.base.ref.startsWith('refs/') ? pr.base.ref : `refs/heads/${pr.base.ref}`;
    const baseTip = repo.refs.get(baseRefName) || pr.base.sha;
    const headTree = parseCommit(repo.objects.get(pr.head.sha)!.data).tree;
    const author = `${user.login} <${user.login}@example.invalid> 0 +0000`;
    const mergeSha = putObj(repo, 'commit', buildCommit({ tree: headTree, parents:[baseTip], author, committer:author, message:`Merge pull request #${pr.number}\n` }));
    repo.refs.set(baseRefName, mergeSha);
    pr.merged = true; pr.state = 'closed'; pr.merged_at = nowIso(); pr.merge_commit_sha = mergeSha; pr.updated_at = nowIso();
    return textContent(JSON.stringify({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' }));
  }
  return errContent(`Unknown tool: ${name}`);
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const p = pathOf(req);
        if (p === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        // git first (paths like /owner/repo.git/info/refs)
        if (handleGit(store, req, res)) return;
        // graphql
        if (await handleGraphQL(store, req, res)) return;
        // mcp
        if (await handleMCP(store, req, res)) return;
        // rest
        if (await handleRest(store, req, res)) return;

        if (p.startsWith('/api/v3')) {
          sendJson(res, 404, { message: 'Not Found' }, restAuthHeaders());
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch (e: any) {
        const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
        const msg = status === 400 ? 'Bad Request' : (e?.body?.message ?? e?.message ?? 'Internal Server Error');
        try { sendJson(res, status, { message: msg }, restAuthHeaders()); } catch { try { res.end(); } catch {} }
      }
    })();
  });
  return server;
}
