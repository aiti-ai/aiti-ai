// profiles 子系统（ctx 模式：initX(ctx) 注册本子系统函数，Phase A 调用）
import { PROFILES_KEY } from './constants.js';
import { lsGetJSON, lsSetJSON } from './storage.js';

export function initProfiles(ctx) {
  ctx.loadUserProfiles = function () { return lsGetJSON(PROFILES_KEY, []);   }

  ctx.saveUserProfiles = function () { lsSetJSON(PROFILES_KEY, ctx.userProfiles);   }

  ctx.getProfiles = function () {
      var out = {};
      Object.keys(ctx.RELEASE_PROFILES).forEach(function (k) { out[k] = ctx.RELEASE_PROFILES[k]; });
      ctx.userProfiles.forEach(function (u) { out[u.name] = u; });
      return out;
      }

  ctx.getProfileOrder = function () {
      return ['default', 'all', 'frozen'].concat(ctx.userProfiles.map(function (u) { return u.name; }));
      }

  ctx.addUserProfile = function (label) {
      ctx.userProfileSeq++;
      var name = 'u' + ctx.userProfileSeq;
      ctx.userProfiles.push({ name: name, label: label, release: ['click', 'hover', 'key', 'wheel', 'scroll', 'touch', 'focus'], builtin: false });
      ctx.saveUserProfiles();
      return name;
      }

  ctx.removeUserProfile = function (name) {
      ctx.userProfiles = ctx.userProfiles.filter(function (u) { return u.name !== name; });
      ctx.saveUserProfiles();
      if (ctx.currentProfile === name) ctx.applyProfile('default');
      }

  ctx.applyProfile = function (name) {
      var profiles = ctx.getProfiles();
      ctx.currentProfile = (name && profiles[name]) ? name : 'default';
      var pf = profiles[ctx.currentProfile] || profiles.default;
      ctx.postToFrame(ctx.selFrameId(), { type: 'dbg_set_profile', payload: { profile: { name: pf.name, release: pf.release } } });
      if (ctx.selfClient && typeof ctx.selfClient.applyProfile === 'function') ctx.selfClient.applyProfile({ name: pf.name, release: pf.release });
      ctx.saveDbgState(); // 方案持久化（刷新后恢复）
      return pf;
      }
}
