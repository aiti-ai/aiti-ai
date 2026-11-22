// localStorage 通用读写（load*/save* 统一委托）
export function lsGetJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
export function lsSetJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
export function lsGetString(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }
export function lsSetString(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
