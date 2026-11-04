/**
 * 交付物协议文本 + 采认校验/归一化。
 */
import path from "node:path";
import type { Delta } from "./providers.ts";

export function deliverableProtocol(projectDir: string, tier: string): string {
	return `
## Plan-Sandbox 模式（当前激活 · tier=${tier}）

你现在处于 plan-sandbox 模式：所有文件写入与命令执行都发生在一个隔离快照中，
真实工作区（${projectDir}）不会被改动。项目目录在沙箱内可写；项目之外只读；临时目录可写。

规则：
1. 自由探索、实验、跑测试/构建来验证方案假设——都发生在快照里，放心试错。
2. 计划完成时，你【必须】调用 declare_deliverables 工具声明交付物，参数：
   - files: 要采认进真实工作区的文件（项目相对路径，如 "src/a.ts"；无文件交付的纯分析/验证任务传空数组 []）
   - deletions: 要从真实工作区删除的文件（谨慎使用，用户会逐项确认）
   - summary: 一句话说明计划/结论
   - gate: 可选，采认后在真实工作区执行的验证命令（如 "npm test"）；失败将整单回滚
   - notes: 可选，补充说明（风险、依赖、验证结果）
   未声明的快照内容（含全部实验产物）会随沙箱一起销毁。
3. files 必须是自洽集合：交付代码 import 的沙箱内新建文件必须一并声明。
4. 不要尝试写项目目录之外——只读层会拒绝。
5. 调用 declare_deliverables 后本轮计划即完成，等待用户采认。
6. 无法继续/方案走不通时调用 plan_abort(reason) 如实中止——不要用占位命令硬撑，出口只有 declare_deliverables（成功收尾）与 plan_abort（失败中止）两个。
`.trim();
}

export interface DeliverableManifest {
	files: string[];
	deletions: string[];
	summary: string;
	gate?: string;
	notes?: string;
	ts: number;
	/** 基线指纹（封存时刻工作区原文件 sha256；added 记 null）。schema 必填（未上线无降级）——
	 *  缺失/覆盖不全 = manifest 不合法，manifestIssues 拒绝采认。见 accept-core.ts computeBaseHashes。 */
	baseHashes: Record<string, string | null>;
	/** 封存时刻（陈旧度提示用） */
	baseTs: number;
}

/** 声明路径归一化：./x、绝对路径（项目内）、反斜杠 → 项目相对 posix 路径；逃逸/非法 → null */
export function normalizeDeliverableRel(raw: string, projectDir: string): string | null {
	let p = String(raw).trim().replace(/\\/g, "/");
	if (!p || p === "." || p === "/") return null;
	const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(projectDir, p);
	const rel = path.relative(projectDir, abs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join("/");
}

/** 声明与快照增量的匹配校验（含归一化）。返回问题列表；空数组 = 通过。 */
export function manifestIssues(d: Delta, m: DeliverableManifest, projectDir: string): string[] {
	const issues: string[] = [];
	const norm = (list: string[]) => {
		const out: string[] = [];
		for (const raw of list) {
			const rel = normalizeDeliverableRel(raw, projectDir);
			if (rel === null) issues.push(`路径非法或逃逸项目目录: "${raw}"`);
			else if (!out.includes(rel)) out.push(rel);
		}
		return out;
	};
	const files = norm(m.files);
	const deletions = norm(m.deletions);
	m.files = files;
	m.deletions = deletions;

	const allowed = new Set([...d.added, ...d.modified]);
	for (const f of m.files) {
		if (!allowed.has(f)) {
			issues.push(`files 中 "${f}" 不在当前快照增量中（不存在 / 未修改 / 路径拼写错误）`);
		}
	}
	const del = new Set(d.deleted);
	for (const f of m.deletions) {
		if (!del.has(f)) {
			issues.push(`deletions 中 "${f}" 不是快照中的删除操作（请确认该文件在沙箱内确实被删除）`);
		}
	}
	// 基线指纹（陈旧恢复分流的安全底线，fusion 方案 §2.1）：必填 + 覆盖「采认可能动到的工作区既有文件」全量
	if (!m.baseHashes || typeof m.baseHashes !== "object") {
		issues.push("manifest 缺少 baseHashes 基线指纹（无法安全比对工作区漂移，请重新声明交付物）");
	} else {
		for (const rel of [...files, ...deletions, ...d.modified, ...d.deleted]) {
			if (!Object.prototype.hasOwnProperty.call(m.baseHashes, rel)) {
				issues.push(`baseHashes 缺少 "${rel}" 的封存时刻指纹（请重新声明交付物）`);
			}
		}
	}
	if (typeof m.baseTs !== "number" || !(m.baseTs > 0)) {
		issues.push("manifest 缺少 baseTs（封存时刻）");
	}
	return issues;
}

export function formatManifest(m: DeliverableManifest, maxList = 30): string {
	const trunc = (a: string[]) => (a.length > maxList ? `${a.slice(0, maxList).join(", ")} …(+${a.length - maxList})` : a.join(", ") || "（无）");
	const lines = [
		`summary: ${m.summary}`,
		`files(${m.files.length}): ${trunc(m.files)}`,
		`deletions(${m.deletions.length}): ${trunc(m.deletions)}`,
	];
	if (m.gate) lines.push(`gate: ${m.gate}`);
	if (m.notes) lines.push(`notes: ${m.notes}`);
	return lines.join("\n");
}
