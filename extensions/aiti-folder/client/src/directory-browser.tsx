/**
 * aiti-folder · 目录浏览器弹窗（自定义路径，/api/cwd/browse）——自手写版迁移，一比一
 */
import { useState, useEffect, useCallback } from "react";
import { apiUrl } from "./host-shim";
import { ct as t } from "./comp-i18n"; // 组件自带多语：内置字典优先，回落宿主 t
import { FolderIcon } from "./icons";

export const rowStyle: Record<string, any> = { display:"flex", alignItems:"center", gap:8, width:"100%", padding:"0 12px", height:26, border:"none", background:"transparent", color:"var(--text)", cursor:"pointer", textAlign:"left" };

export function DirectoryBrowser({ initialPath, onSelect, onCancel }: { initialPath?: string; onSelect: (p: string) => void; onCancel: () => void }) {
  const [path, setPath] = useState(initialPath || "");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback((target?: string) => {
    if (loading) return; setLoading(true); setError(null);
    const p = target ? { path: target } : {};
    fetch(apiUrl("/api/cwd/browse"), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(p) })
      .then(async r => { const d = await r.json(); if (!r.ok || d.error) throw new Error(d.error||("HTTP "+r.status)); setData(d); setPath(d.path); })
      .catch(e => setError(e&&e.message?e.message:String(e)))
      .finally(()=>setLoading(false));
  }, [loading]);
  useEffect(()=>{ load(initialPath||""); /* eslint-disable-line */ }, []);
  useEffect(()=>{ const k=(e:any)=>{ if(e.key==="Escape") onCancel(); }; document.addEventListener("keydown",k,true); return ()=>document.removeEventListener("keydown",k,true); }, [onCancel]);
  const dirs = (data && data.directories) || []; const drives = data && data.drives;
  return (
    <div onClick={(e)=>{ if(e.target===e.currentTarget) onCancel(); }} style={{ position:"fixed", inset:0, zIndex:400, background:"rgba(0,0,0,0.35)", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ width:"min(560px,92vw)", maxHeight:"80vh", display:"flex", flexDirection:"column", background:"var(--bg-panel)", border:"1px solid var(--border)", borderRadius:8, boxShadow:"0 8px 32px rgba(0,0,0,0.3)", overflow:"hidden" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderBottom:"1px solid var(--border)", background:"var(--bg)", flexShrink:0 }}>
          <span style={{ fontSize:13, fontWeight:600, color:"var(--text)", flex:1 }}>{t("sidebar.customPath")}</span>
          <button onClick={onCancel} title={t("i18n.close")} style={{ height:28, padding:"0 10px", border:"1px solid var(--border)", borderRadius:5, background:"var(--bg-panel)", color:"var(--text)", cursor:"pointer", fontSize:12 }}>✕</button>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 12px", borderBottom:"1px solid var(--border)", flexShrink:0, fontSize:12, color:"var(--text-muted)", fontFamily:"var(--font-mono)", overflowX:"auto", whiteSpace:"nowrap" }}>
          {(data && data.parentPath!=null) ? <button onClick={()=>load(data.parentPath)} title={t("files.parentDir")} style={{ height:22, padding:"0 6px", border:"1px solid var(--border)", borderRadius:4, background:"var(--bg-panel)", color:"var(--text-muted)", cursor:"pointer", fontSize:12, flexShrink:0 }}>↑</button> : null}
          <span title={path} style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{path||"/"}</span>
        </div>
        <div style={{ flex:1, overflowY:"auto", padding:"4px 0" }}>
          {loading ? <div style={{ padding:"12px", fontSize:12, color:"var(--text-dim)" }}>{t("files.loading")}</div> : null}
          {error ? <div style={{ padding:"12px", fontSize:12, color:"var(--danger, #f87171)" }}>{error}</div> : null}
          {(!loading && !error && drives && drives.length>0) ? drives.map((d: any)=> <button key={d.path} onClick={()=>load(d.path)} style={rowStyle}><FolderIcon open={false} /><span style={{fontSize:12}}>{d.name}</span></button>) : null}
          {(!loading && !error && dirs.length===0 && (!drives||drives.length===0)) ? <div style={{ padding:"12px", fontSize:12, color:"var(--text-dim)" }}>{t("files.noSubdirs")}</div> : null}
          {(!loading && !error) ? dirs.map((d: any)=> (
            <button key={d.path} onClick={()=>load(d.path)} onDoubleClick={()=>onSelect(d.path)} style={rowStyle}>
              <FolderIcon open={false} />
              <span style={{ flex:1, fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.name}</span>
              <span style={{fontSize:10,color:"var(--text-dim)"}}>→</span>
            </button>
          )) : null}
        </div>
        <div style={{ display:"flex", gap:8, padding:"8px 12px", borderTop:"1px solid var(--border)", flexShrink:0, background:"var(--bg)" }}>
          <button onClick={()=>path&&onSelect(path)} disabled={!path} style={{ height:28, padding:"0 12px", border:"none", borderRadius:5, background:"var(--accent)", color:"#fff", cursor:path?"pointer":"not-allowed", fontSize:12, fontWeight:600, opacity:path?1:0.5 }}>{t("files.selectFolder")}</button>
          <button onClick={onCancel} style={{ height:28, padding:"0 10px", border:"1px solid var(--border)", borderRadius:5, background:"var(--bg-panel)", color:"var(--text)", cursor:"pointer", fontSize:12 }}>{t("files.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
