/**
 * Importers: read other agents' file-based memory and turn it into
 * meminbox documents. Each item carries a stable `sourceKey`, so
 * re-running an import updates documents in place instead of
 * duplicating them (see MemoryService.writeDocument).
 *
 * Built-in sources:
 *   claude-code  ~/.claude/projects/<project>/memory/*.md  (MEMORY.md, the index, is skipped)
 *   codex        ~/.codex/memories/**\/*.md               ($CODEX_HOME respected)
 *   gemini       the "## Gemini Added Memories" section of ~/.gemini/GEMINI.md
 * Anything else (Cursor rules, an Obsidian folder, ...) goes through
 * `collectDir` with an explicit agent name.
 *
 * Importers only READ. Nothing here touches the source files.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
export const BUILTIN_SOURCES = ["claude-code", "codex", "gemini"];
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 5000;
const MARKDOWN_EXT = new Set([".md", ".mdc", ".markdown"]);
// -- secret detection -------------------------------------------------------
/**
 * Shared memory is readable by every connected agent, so a file that
 * looks like it holds a credential is skipped unless the user opts in.
 * Only the KIND of secret is ever reported, never the value.
 */
const SECRET_PATTERNS = [
    { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "OpenAI/Anthropic-style API key", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/ },
    { label: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
    { label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
    { label: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
    { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    {
        label: "credential assignment",
        re: /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=.]{16,}/i,
    },
];
export function detectSecret(text) {
    for (const p of SECRET_PATTERNS)
        if (p.re.test(text))
            return p.label;
    return null;
}
// -- markdown helpers ---------------------------------------------------------
export function parseFrontmatter(md) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
    if (!m)
        return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (kv && kv[2].trim() !== "")
            out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
}
function firstHeading(md) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(md);
    return m?.[1];
}
function titleFor(md, fallback) {
    const fm = parseFrontmatter(md);
    return fm.name ?? fm.title ?? firstHeading(md) ?? fallback;
}
export function slugify(s) {
    const slug = s
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
    return slug || undefined;
}
/** Read a file as an import candidate, or say why it is skipped. */
function readCandidate(path, opts) {
    const size = statSync(path).size;
    if (size > MAX_BYTES)
        return { ok: false, reason: `larger than ${MAX_BYTES / 1024} KB` };
    const content = readFileSync(path, "utf8");
    if (content.trim() === "")
        return { ok: false, reason: "empty" };
    if (!opts.allowSecrets) {
        const secret = detectSecret(content);
        if (secret)
            return { ok: false, reason: `looks like it contains a ${secret} (use --allow-secrets to import anyway)` };
    }
    return { ok: true, content };
}
function walkMarkdown(root) {
    const out = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (out.length >= MAX_FILES)
                return;
            const p = join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name.startsWith(".") || e.name === "node_modules")
                    continue;
                visit(p);
            }
            else if (e.isFile() && MARKDOWN_EXT.has(extname(e.name).toLowerCase())) {
                out.push(p);
            }
        }
    };
    visit(root);
    return out;
}
const toPosix = (p) => p.split(sep).join("/");
// -- Claude Code --------------------------------------------------------------
/** Claude Code names a project's directory after its path with every non-alphanumeric replaced by "-". */
export function encodeClaudePath(p) {
    return p.replace(/[^A-Za-z0-9]/g, "-");
}
/**
 * Find the real directory an encoded Claude Code project name stands for,
 * by walking the filesystem (the encoding is lossy: "-" may have been
 * "/", "." or "-"). Returns null when the project no longer exists here.
 */
export function resolveEncodedPath(encoded, root = "/") {
    if (process.platform === "win32" || !encoded.startsWith("-"))
        return null;
    const walk = (dir, rest, depth) => {
        if (depth > 16)
            return null;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return null;
        }
        for (const e of entries) {
            if (!e.isDirectory() && !e.isSymbolicLink())
                continue;
            const enc = encodeClaudePath(e.name);
            if (rest === enc)
                return join(dir, e.name);
            if (rest.startsWith(`${enc}-`)) {
                const found = walk(join(dir, e.name), rest.slice(enc.length + 1), depth + 1);
                if (found)
                    return found;
            }
        }
        return null;
    };
    return walk(root, encoded.slice(1), 0);
}
/** The cwd recorded in one of the project's session transcripts, if any. */
function cwdFromTranscripts(projectDir) {
    let files;
    try {
        files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    }
    catch {
        return null;
    }
    for (const f of files.slice(0, 5)) {
        let fd;
        try {
            fd = openSync(join(projectDir, f), "r");
            const buf = Buffer.alloc(64 * 1024);
            const n = readSync(fd, buf, 0, buf.length, 0);
            const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString("utf8"));
            if (m)
                return JSON.parse(`"${m[1]}"`);
        }
        catch {
            // unreadable transcript: try the next one
        }
        finally {
            if (fd !== undefined)
                closeSync(fd);
        }
    }
    return null;
}
/**
 * Project slug for a Claude Code project directory: the basename of the
 * real project path (worktrees fold into their repository), or undefined
 * for the home directory itself, which belongs in the default project.
 */
export function claudeProjectSlug(projectDir, encodedName, home) {
    const real = resolveEncodedPath(encodedName) ?? cwdFromTranscripts(projectDir);
    if (real) {
        const repo = real.split(/[\\/]\.claude[\\/]worktrees[\\/]/)[0];
        if (resolve(repo) === resolve(home))
            return undefined;
        return slugify(basename(repo));
    }
    const encHome = encodeClaudePath(home);
    if (encodedName === encHome)
        return undefined;
    const rest = encodedName.startsWith(`${encHome}-`) ? encodedName.slice(encHome.length + 1) : encodedName;
    return slugify(rest);
}
function collectClaudeCode(opts, out) {
    const base = opts.env.CLAUDE_CONFIG_DIR ?? join(opts.home, ".claude");
    const projectsDir = join(base, "projects");
    if (!existsSync(projectsDir)) {
        out.notes.push(`claude-code: ${projectsDir} not found, skipped`);
        return;
    }
    for (const name of readdirSync(projectsDir).sort()) {
        const projectDir = join(projectsDir, name);
        const memDir = join(projectDir, "memory");
        let files;
        try {
            files = readdirSync(memDir).filter((f) => f.toLowerCase().endsWith(".md") && f.toLowerCase() !== "memory.md");
        }
        catch {
            continue;
        }
        if (files.length === 0)
            continue;
        const projectSlug = claudeProjectSlug(projectDir, name, opts.home);
        for (const f of files.sort()) {
            const path = join(memDir, f);
            const r = readCandidate(path, opts);
            if (!r.ok) {
                out.skipped.push({ path, reason: r.reason });
                continue;
            }
            out.items.push({
                agent: "claude-code",
                sourceKey: `claude-code:${name}/${f}`,
                title: titleFor(r.content, basename(f, extname(f))),
                contentMd: r.content,
                projectSlug,
                path,
            });
        }
    }
}
// -- Codex ----------------------------------------------------------------------
function collectCodex(opts, out) {
    const base = opts.env.CODEX_HOME ?? join(opts.home, ".codex");
    const memDir = join(base, "memories");
    if (!existsSync(memDir)) {
        out.notes.push(`codex: ${memDir} not found, skipped`);
        return;
    }
    const files = walkMarkdown(memDir);
    if (files.length === 0)
        out.notes.push(`codex: no memory files in ${memDir}`);
    for (const path of files) {
        const rel = toPosix(relative(memDir, path));
        const r = readCandidate(path, opts);
        if (!r.ok) {
            out.skipped.push({ path, reason: r.reason });
            continue;
        }
        out.items.push({
            agent: "codex",
            sourceKey: `codex:memories/${rel}`,
            title: titleFor(r.content, `Codex memory: ${rel.replace(/\.[^.]+$/, "")}`),
            contentMd: r.content,
            path,
        });
    }
}
// -- Gemini CLI -------------------------------------------------------------------
const GEMINI_SECTION = "## Gemini Added Memories";
/** The body of the section Gemini CLI's save_memory tool appends to. */
export function geminiMemories(md) {
    const lines = md.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === GEMINI_SECTION);
    if (start < 0)
        return null;
    const body = [];
    for (const l of lines.slice(start + 1)) {
        if (/^#{1,2}\s/.test(l))
            break;
        body.push(l);
    }
    const text = body.join("\n").trim();
    return text === "" ? null : text;
}
function collectGemini(opts, out) {
    const path = join(opts.home, ".gemini", "GEMINI.md");
    if (!existsSync(path)) {
        out.notes.push(`gemini: ${path} not found, skipped`);
        return;
    }
    const memories = geminiMemories(readFileSync(path, "utf8"));
    if (!memories) {
        out.notes.push(`gemini: no "${GEMINI_SECTION}" section in ${path}`);
        return;
    }
    if (!opts.allowSecrets) {
        const secret = detectSecret(memories);
        if (secret) {
            out.skipped.push({ path, reason: `looks like it contains a ${secret} (use --allow-secrets to import anyway)` });
            return;
        }
    }
    out.items.push({
        agent: "gemini-cli",
        sourceKey: "gemini:GEMINI.md#gemini-added-memories",
        title: "Gemini CLI memories",
        contentMd: memories,
        path,
    });
}
// -- entry points -------------------------------------------------------------------
export function collectSources(sources, opts = {}) {
    const full = { ...opts, home: opts.home ?? homedir(), env: opts.env ?? process.env };
    const out = { items: [], skipped: [], notes: [] };
    for (const s of sources) {
        switch (s) {
            case "claude-code":
                collectClaudeCode(full, out);
                break;
            case "codex":
                collectCodex(full, out);
                break;
            case "gemini":
                collectGemini(full, out);
                break;
            default:
                throw new Error(`Unknown import source "${s}". Known sources: ${BUILTIN_SOURCES.join(", ")} (or use --dir <path>).`);
        }
    }
    return out;
}
/** Import every Markdown file under `dir` (hidden directories and node_modules are skipped). */
export function collectDir(dir, agent, opts = {}) {
    const root = resolve(dir);
    const out = { items: [], skipped: [], notes: [] };
    if (!existsSync(root) || !statSync(root).isDirectory())
        throw new Error(`Not a directory: ${dir}`);
    const files = walkMarkdown(root);
    if (files.length === 0)
        out.notes.push(`${root}: no Markdown files found`);
    for (const path of files) {
        const rel = toPosix(relative(root, path));
        const r = readCandidate(path, opts);
        if (!r.ok) {
            out.skipped.push({ path, reason: r.reason });
            continue;
        }
        out.items.push({
            agent,
            sourceKey: `dir:${toPosix(path)}`,
            title: titleFor(r.content, rel.replace(/\.[^.]+$/, "")),
            contentMd: r.content,
            path,
        });
    }
    return out;
}
//# sourceMappingURL=importers.js.map