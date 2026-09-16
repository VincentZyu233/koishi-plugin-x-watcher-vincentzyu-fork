<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { send } from "@koishijs/client";
import type { ConsoleRow, ConsoleState, SubscriptionMutation } from "../src/console";

const state = ref<ConsoleState>();
const selected = ref<ConsoleRow | null>(null);
const creating = ref(false);
const busy = ref(false);
const loading = ref(false);
const avatarRetry = ref(0);
const message = ref("");
const error = ref("");
const search = ref("");
const tab = ref("all");
const platform = ref("");
const botFilter = ref("");
const channel = ref("");
const page = ref(1);
const size = ref(20);
const confirmDelete = ref(false);
const form = reactive({
  username: "", bot: "", channelId: "", filter: "",
  media: false, quote: false, retweet: false,
});
let timer: ReturnType<typeof setInterval> | undefined;
let alive = true;
const rows = computed(() => state.value?.rows ?? []);
const bots = computed(() => state.value?.bots ?? []);
const botChoices = computed(() => {
  const result = new Map(bots.value.map(bot => [botKey(bot.platform, bot.id), bot]));
  for (const row of rows.value) {
    const key = botKey(row.platform, row.botId);
    if (!result.has(key)) result.set(key, { platform: row.platform, id: row.botId, name: row.botId + "（未加载）", online: false });
  }
  return [...result.values()];
});
const ready = computed(() => state.value?.phase === "ready");
const activeCount = computed(() => rows.value.filter(row => row.active).length);
const platforms = computed(() => [...new Set(rows.value.map(row => row.platform))]);
const channels = computed(() => [...new Set(rows.value.filter(row => !platform.value || row.platform === platform.value).map(row => row.channelId))]);
const filtered = computed(() => rows.value.filter(row =>
  (tab.value === "all" || row.active === (tab.value === "active"))
  && (!platform.value || row.platform === platform.value)
  && (!botFilter.value || botKey(row.platform, row.botId) === botFilter.value)
  && (!channel.value || row.channelId === channel.value)
  && (row.twitter_username + " " + row.twitter_fullname).toLowerCase().includes(search.value.toLowerCase())
).sort((a, b) => b.id - a.id));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / size.value)));
const visible = computed(() => filtered.value.slice((Math.min(page.value, pages.value) - 1) * size.value, Math.min(page.value, pages.value) * size.value));
const availableBots = computed(() => bots.value.filter(bot => creating.value || bot.platform === selected.value?.platform));
const chosenBot = computed(() => bots.value.find(bot => botKey(bot.platform, bot.id) === form.bot));
const targets = computed(() => [...new Set(rows.value.filter(row => row.platform === chosenBot.value?.platform).map(row => row.channelId))]);
const opened = computed(() => creating.value || selected.value !== null);
const stale = computed(() => selected.value && rows.value.find(row => row.id === selected.value?.id)?.revision !== selected.value.revision);
function botKey(platform: string, id: string) { return JSON.stringify([platform, id]); }
function botStatus(row: ConsoleRow) {
  const bot = bots.value.find(bot => bot.platform === row.platform && bot.id === row.botId);
  return !bot ? "机器人未加载" : bot.online ? "在线" : "机器人离线";
}
function date(value: string) { return new Date(value).toLocaleString(); }
function avatarFailure(event: Event) { if (event.target instanceof HTMLImageElement) event.target.style.display = "none"; }
async function refresh(retryAvatars = false) {
  if (loading.value) return;
  if (retryAvatars) avatarRetry.value++;
  loading.value = true;
  try { const result = await send("x-watcher/state"); if (alive) state.value = result; }
  catch (e) { if (alive) error.value = String(e); }
  finally { loading.value = false; }
}
function open(row: ConsoleRow) {
  selected.value = { ...row }; creating.value = false; confirmDelete.value = false;
  Object.assign(form, { username: row.twitter_username, bot: botKey(row.platform, row.botId),
    channelId: row.channelId, filter: row.filter_regexp ?? "", media: row.media,
    quote: row.include_quote === true, retweet: row.include_retweet === true });
}
function create() {
  selected.value = null; creating.value = true; confirmDelete.value = false;
  Object.assign(form, { username: "", bot: "", channelId: "", filter: "", media: false, quote: false, retweet: false });
}
function close() { selected.value = null; creating.value = false; confirmDelete.value = false; }
async function submit(action: SubscriptionMutation["action"] = "update") {
  if (busy.value || !ready.value) return;
  busy.value = true; error.value = ""; message.value = "";
  try {
    const rules = { filter: form.filter.trim() || null, media: form.media, quote: form.quote, retweet: form.retweet };
    let result;
    if (creating.value) {
      const bot = chosenBot.value;
      if (!bot) throw new Error("请选择机器人");
      result = await send("x-watcher/create", {
        platform: bot.platform, botId: bot.id, channelId: form.channelId,
        username: form.username, rules,
      });
    } else {
      const row = selected.value;
      if (!row) return;
      result = await send("x-watcher/mutate", {
        id: row.id, revision: row.revision, action, rules,
        botId: chosenBot.value?.id ?? row.botId,
      });
    }
    if (!result.ok) throw new Error(result.message);
    message.value = result.message;
    close();
    await refresh();
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; }
}
onMounted(() => {
  refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
});
onUnmounted(() => { alive = false; if (timer) clearInterval(timer); });
</script>

<template>
  <k-layout>
    <div class="x-page">
      <main class="timeline">
        <header class="masthead">
          <div><h1>𝕏 <span>订阅管理</span></h1><p>{{ activeCount }} 个订阅中 · {{ rows.length }} 条记录</p></div>
          <button class="primary" :disabled="!ready || busy" @click="create">＋ 新增订阅</button>
        </header>
        <nav class="tabs" aria-label="订阅状态">
          <button v-for="item in [{id:'all', label:'全部'}, {id:'active', label:'订阅中'}, {id:'inactive', label:'已取消'}]"
            :key="item.id" :class="{ current: tab === item.id }" :aria-pressed="tab === item.id" @click="tab = item.id; page = 1">{{ item.label }}</button>
        </nav>
        <div class="filters">
          <input v-model="search" type="search" aria-label="搜索账号" placeholder="⌕ 搜索昵称或 @账号" @input="page = 1">
          <div class="filter-row">
            <select v-model="platform" aria-label="平台" @change="channel = ''; page = 1"><option value="">全部平台</option><option v-for="p in platforms" :key="p">{{ p }}</option></select>
            <select v-model="botFilter" aria-label="机器人筛选" @change="page = 1"><option value="">全部机器人</option><option v-for="b in botChoices" :key="botKey(b.platform,b.id)" :value="botKey(b.platform,b.id)">{{ b.name }} · {{ b.platform }}</option></select>
            <select v-model="channel" aria-label="频道" @change="page = 1"><option value="">全部频道</option><option v-for="c in channels" :key="c">{{ c }}</option></select>
            <button :disabled="loading" @click="refresh(true)" aria-label="刷新">↻</button>
          </div>
        </div>
        <div v-if="error" class="notice failure" role="alert">{{ error }}<button @click="error = ''" aria-label="关闭错误">×</button></div>
        <div v-if="message" class="notice" role="status">{{ message }}</div>
        <div v-if="!ready" class="empty">服务{{ state?.phase === 'failed' ? '初始化失败，请检查插件日志' : '尚未就绪' }}。</div>
        <div v-else-if="!visible.length" class="empty"><h2>这里还没有订阅</h2><p>调整筛选条件，或添加你想关注的 X 账号。</p></div>
        <button v-for="row in visible" :key="row.id" :disabled="busy" class="subscription" :class="{ selected: selected?.id === row.id }" @click="open(row)">
          <span class="avatar"><span>{{ row.twitter_fullname.slice(0,1) || '𝕏' }}</span><img v-if="row.twitter_avatar_url" :key="row.twitter_avatar_url + ':' + avatarRetry" :src="row.twitter_avatar_url" alt="" loading="lazy" referrerpolicy="no-referrer" @error="avatarFailure"></span>
          <span class="row-content">
            <span class="identity"><strong>{{ row.twitter_fullname }}</strong><span class="muted">@{{ row.twitter_username }}</span><span class="badge" :class="{ active: row.active }">{{ row.active ? '订阅中' : '已取消' }}</span></span>
            <span class="target">{{ row.platform }} · {{ row.channelId }}</span>
            <span class="muted">机器人 {{ row.botId }} · {{ botStatus(row) }}</span>
            <span class="rules">{{ row.media ? '🖼️ 媒体' : '无媒体' }} · {{ row.include_quote ? '包含引用' : '无引用' }} · {{ row.include_retweet ? '包含转推' : '无转推' }}</span>
            <span v-if="row.filter_regexp" class="muted filter-text">过滤：{{ row.filter_regexp }}</span>
          </span>
        </button>
        <footer class="pagination">
          <button :disabled="page <= 1" @click="page = Math.max(1, Math.min(page, pages) - 1)">上一页</button>
          <span>{{ Math.min(page, pages) }} / {{ pages }}</span>
          <button :disabled="page >= pages" @click="page++">下一页</button>
          <select v-model.number="size" aria-label="每页数量" @change="page = 1"><option :value="20">20 条</option><option :value="50">50 条</option><option :value="100">100 条</option></select>
        </footer>
      </main>
      <div v-if="opened" class="backdrop" @click="!busy && close()"></div>
      <aside class="sidebar" :class="{ opened }">
        <section class="panel service"><h2>运行状态</h2><p><span class="dot" :class="{ online: ready }"></span>{{ state?.provider ?? '加载中' }} / {{ state?.mode ?? '—' }}</p><p class="muted">仅支持单实例 · 每 15 秒刷新</p></section>
        <section v-if="!opened" class="panel empty-detail"><h2>你的订阅，一目了然</h2><p class="muted">选择左侧订阅查看详情与推送规则，或添加一个新账号。</p><span class="big-x">𝕏</span></section>
        <section v-else class="panel editor">
          <div class="editor-title"><h2>{{ creating ? '新增订阅' : '订阅详情' }}</h2><button :disabled="busy" @click="close" aria-label="关闭详情">×</button></div>
          <p v-if="error" class="failure" role="alert">{{ error }}</p>
          <p v-if="stale" class="failure">此订阅已变更，请重新选择列表中的记录。</p>
          <form @submit.prevent="submit()">
            <fieldset :disabled="busy || !ready || !!stale">
              <label>X 用户名<input v-model="form.username" required :readonly="!creating" placeholder="OpenAI"></label>
              <label>发送机器人<select v-model="form.bot" required>
                <option value="" disabled>请选择机器人</option>
                <option v-if="selected && !bots.some(b => botKey(b.platform,b.id) === form.bot)" :value="form.bot">{{ selected.botId }}（未加载）</option>
                <option v-for="b in availableBots" :key="botKey(b.platform,b.id)" :value="botKey(b.platform,b.id)">{{ b.name }} · {{ b.platform }} · {{ b.id }}{{ b.online ? '' : '（离线）' }}</option>
              </select></label>
              <label>目标频道 ID<input v-model="form.channelId" :readonly="!creating" list="x-targets" required placeholder="输入适配器实际 channelId"></label>
              <datalist id="x-targets"><option v-for="target in targets" :key="target" :value="target"/></datalist>
              <p v-if="creating" class="hint">可选择已有频道或输入实际 channelId。私聊也需填写适配器的实际频道标识。</p>
              <label>正文过滤正则<input v-model="form.filter" placeholder="留空表示不筛选"></label>
              <label class="toggle"><span>🖼️ 包含媒体</span><input v-model="form.media" type="checkbox"></label>
              <label class="toggle"><span>💬 包含引用推文</span><input v-model="form.quote" type="checkbox"></label>
              <label class="toggle"><span>🔁 包含转推</span><input v-model="form.retweet" type="checkbox"></label>
              <button class="primary wide" type="submit">{{ busy ? '保存中…' : creating ? '创建订阅' : '保存规则' }}</button>
            </fieldset>
          </form>
          <template v-if="selected">
            <dl><dt>稳定 X ID</dt><dd>{{ selected.twitter_id }}</dd><dt>创建时间</dt><dd>{{ date(selected.create_at) }}</dd><dt>更新时间</dt><dd>{{ date(selected.update_at) }}</dd><dt>最后推文 ID</dt><dd>{{ selected.last_tweet_id || '无' }}</dd></dl>
            <div class="actions"><button :disabled="busy || !ready || !!stale" @click="submit(selected.active ? 'deactivate' : 'reactivate')">{{ selected.active ? '取消订阅' : '恢复订阅' }}</button><button class="danger" :disabled="busy || !ready || !!stale" @click="confirmDelete = true">永久删除</button></div>
            <p class="hint">取消会保留记录；恢复从最新动态开始，不补发历史。</p>
          </template>
        </section>
      </aside>
      <div v-if="confirmDelete && selected" class="modal-backdrop">
        <section role="dialog" aria-modal="true" aria-labelledby="delete-title" class="panel modal">
          <h2 id="delete-title">永久删除订阅？</h2><p>@{{ selected.twitter_username }}</p><p>{{ selected.platform }} · 机器人 {{ selected.botId }}</p><p>频道 {{ selected.channelId }}</p><p class="muted">此操作无法撤销，仅删除这条订阅记录。</p>
          <div class="actions"><button autofocus :disabled="busy" @click="confirmDelete = false">保留订阅</button><button class="danger" :disabled="busy || !!stale || !ready" @click="submit('delete')">确认永久删除</button></div>
        </section>
      </div>
    </div>
  </k-layout>
</template>

<style scoped>
.x-page{--x-blue:#1d9bf0;--x-line:var(--k-color-divider,#dce1e5);--x-muted:var(--k-text-light,#71767b);--x-bg:var(--k-page-bg,#fff);color:var(--k-text-dark,#0f1419);background:var(--x-bg);min-height:100%;display:grid;grid-template-columns:minmax(360px,680px) minmax(300px,380px);justify-content:center;font-size:14px;line-height:1.5}
.x-page *{box-sizing:border-box}.timeline{border-inline:1px solid var(--x-line);min-width:0}.masthead{padding:22px 24px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}h1,h2,p{margin:0}h1{font-size:28px;display:flex;gap:14px;align-items:center}h1 span{font-size:21px}h2{font-size:20px;font-weight:800}.masthead p,.muted,.hint,dt{color:var(--x-muted)}.masthead p{margin-top:5px;font-size:13px}
button,input,select{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--x-line);border-radius:999px;padding:8px 17px;background:transparent;font-weight:650;transition:background .15s}button:hover{background:color-mix(in srgb,var(--x-blue) 8%,transparent)}button:disabled{opacity:.45;cursor:not-allowed}button.primary{background:var(--x-blue);border-color:var(--x-blue);color:white}button.primary:hover{background:#198bd7}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--x-blue);outline-offset:2px}.tabs{display:flex;border-bottom:1px solid var(--x-line)}.tabs button{flex:1;border:0;border-radius:0;padding:17px 8px;position:relative;color:var(--x-muted)}.tabs .current{color:inherit}.tabs .current:after{content:"";position:absolute;height:4px;border-radius:3px;background:var(--x-blue);bottom:0;left:30%;right:30%}
.filters{padding:16px;border-bottom:1px solid var(--x-line)}input:not([type=checkbox]),select{width:100%;min-width:0;background:transparent;border:1px solid var(--x-line);border-radius:12px;padding:10px 12px}input[type=search]{border-radius:999px;background:color-mix(in srgb,var(--x-muted) 8%,transparent)}.filter-row{display:flex;gap:8px;margin-top:10px}.filter-row select{font-size:12px;padding:7px}.filter-row button{padding:4px 12px;font-size:22px}.subscription{display:flex;gap:12px;text-align:left;width:100%;padding:18px 20px;border:0;border-bottom:1px solid var(--x-line);border-radius:0;font-weight:400}.subscription.selected{background:color-mix(in srgb,var(--x-blue) 9%,transparent);box-shadow:inset 3px 0 var(--x-blue)}.avatar{position:relative;flex-shrink:0;display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:color-mix(in srgb,var(--x-blue) 15%,var(--x-bg));color:var(--x-blue);font-size:22px;overflow:hidden}.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.row-content{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;overflow-wrap:anywhere}.identity{display:flex;align-items:center;flex-wrap:wrap;gap:6px}.badge{font-size:11px;border:1px solid var(--x-line);border-radius:99px;padding:1px 8px;margin-left:auto;color:var(--x-muted)}.badge.active{color:var(--x-blue);border-color:color-mix(in srgb,var(--x-blue) 40%,transparent)}.target{margin-top:3px}.rules,.filter-text{font-size:12px}.pagination{display:flex;justify-content:center;gap:12px;align-items:center;padding:20px 10px;font-size:12px}.pagination select{width:auto}.sidebar{padding:20px;display:flex;flex-direction:column;gap:18px;min-width:0}.panel{border:1px solid var(--x-line);border-radius:18px;padding:20px}.service p{margin-top:10px}.dot{display:inline-block;width:8px;height:8px;background:#f59e0b;border-radius:50%;margin-right:8px}.dot.online{background:#00ba7c}.empty-detail p{margin-top:12px}.big-x{display:block;font-size:72px;text-align:center;padding:35px;color:var(--x-muted);opacity:.3}.editor-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.editor-title button{border:0;padding:0 8px;font-size:25px}fieldset{padding:0;margin:0;border:0;min-width:0}label{display:block;margin:14px 0;font-size:13px;font-weight:650}label input,label select{margin-top:6px;font-weight:400}.toggle{display:flex;justify-content:space-between;align-items:center;padding:8px 0}.toggle input{accent-color:var(--x-blue);width:18px;height:18px}.wide{width:100%;margin-top:8px}.hint{font-size:12px;margin-top:10px}.actions{display:flex;gap:8px;flex-wrap:wrap}.danger,.failure{color:#e5484d}.danger{border-color:#e5484d}dl{font-size:12px;border-top:1px solid var(--x-line);padding-top:16px;margin-top:20px}dd{margin:2px 0 10px;overflow-wrap:anywhere}.empty{padding:50px 28px}.empty p{margin-top:10px;color:var(--x-muted)}.notice{padding:14px 20px;border-bottom:1px solid var(--x-line);overflow-wrap:anywhere}.notice button{float:right;padding:0 7px;border:0}.backdrop{display:none}.modal-backdrop{position:fixed;inset:0;background:#0008;z-index:1100;display:grid;place-items:center;padding:20px}.modal{background:var(--x-bg);max-width:440px;width:100%;box-shadow:0 15px 70px #0005;overflow-wrap:anywhere}.modal p{margin:12px 0}.modal .actions{margin-top:24px}option{background:var(--x-bg)}
@media(max-width:1000px){.x-page{grid-template-columns:minmax(0,1fr)}.sidebar{display:none}.sidebar.opened{display:flex;position:fixed;right:0;top:0;bottom:0;width:min(420px,95vw);background:var(--x-bg);z-index:1001;overflow:auto}.sidebar.opened .service{display:none}.backdrop{display:block;position:fixed;inset:0;background:#0007;z-index:1000}.masthead{padding:18px 16px}.subscription{padding:16px}.pagination{gap:6px}.pagination button{padding:7px 10px}}
</style>
