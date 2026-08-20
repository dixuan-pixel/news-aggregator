#!/usr/bin/env node
/**
 * 服务端新闻抓取脚本（GitHub Actions 定时运行）
 * - 无第三方依赖，仅用 Node.js 原生 fetch + 正则解析 XML
 * - 抓取 RSS_FEEDS 各分类，去重、按新鲜度排序，输出 news.json
 * - news.json 结构与前端 news.html 兼容：
 *   [ {cat, title, summary, source, url, time, _ts, _isFresh}, ... ]
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ===== RSS Feed 配置 =====
// 优先直连新闻机构的滚动 RSS；Google News 仅补充候选，避免宽泛频道把
// 评论、科普和专栏文章挤到最前面。weight 用于同等新鲜度下的来源排序。
const RSS_FEEDS = {
  '国内要闻': [
    { url: 'https://www.chinanews.com.cn/rss/china.xml', weight: 35 },
    { url: 'https://www.chinanews.com.cn/rss/society.xml', weight: 30 },
    { url: 'https://news.google.com/rss/search?q=%E4%B8%AD%E5%9B%BD+(%E5%8F%91%E5%B8%83+OR+%E9%80%9A%E6%8A%A5+OR+%E5%AE%A3%E5%B8%83+OR+%E5%90%AF%E5%8A%A8+OR+%E5%8F%91%E7%94%9F)+when:1d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', weight: 12 },
    { url: 'https://www.zaobao.com.sg/rss/realtime/china.xml', weight: 10 },
  ],
  '科技前沿': [
    { url: 'https://www.ithome.com/rss/', weight: 25 },
    { url: 'https://news.google.com/rss/search?q=AI+%E7%A7%91%E6%8A%80+%E5%8F%91%E5%B8%83+OR+%E4%B8%8A%E7%BA%BF+OR+%E7%AA%81%E7%A0%B4+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', weight: 12 },
    { url: 'https://36kr.com/feed', weight: 15 },
  ],
  '经济金融': [
    { url: 'https://www.cls.cn/feed', weight: 28 },
    { url: 'https://www.chinanews.com.cn/rss/finance.xml', weight: 24 },
    { url: 'https://news.google.com/rss/search?q=%E7%BB%8F%E6%B5%8E+%E9%87%91%E8%9E%8D+%E8%82%A1%E5%B8%82+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', weight: 10 },
  ],
  '国际局势': [
    { url: 'https://www.chinanews.com.cn/rss/world.xml', weight: 25 },
    { url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', weight: 20 },
    { url: 'https://www.rfi.fr/cn/rss', weight: 18 },
    { url: 'https://news.google.com/rss/search?q=%E5%9B%BD%E9%99%85+%E5%B1%80%E5%8A%BF+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', weight: 8 },
  ],
  '争议新闻': [
    { url: 'https://www.chinanews.com.cn/rss/society.xml', weight: 22 },
    { url: 'https://news.google.com/rss/search?q=%E7%A4%BE%E4%BC%9A+%E7%83%AD%E7%82%B9+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', weight: 10 },
    { url: 'https://www.zaobao.com.sg/rss/forum.xml', weight: 8 },
  ],
  '健康养生': [
    { url: 'https://www.chinanews.com.cn/rss/health.xml', weight: 32 },
    { url: 'https://www.chinanews.com.cn/rss/scroll-news.xml', weight: 18 },
    { url: 'https://news.google.com/rss/search?q=(%E5%8D%AB%E5%81%A5%E5%A7%94+OR+%E5%8C%BB%E4%BF%9D+OR+%E8%8D%AF%E7%9B%91%E5%B1%80+OR+%E6%96%B0%E8%8D%AF+OR+%E7%96%AB%E8%8B%97)+(%E5%8F%91%E5%B8%83+OR+%E9%80%9A%E6%8A%A5+OR+%E8%8E%B7%E6%89%B9+OR+%E5%90%AF%E5%8A%A8)+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans', weight: 14 },
  ],
};

const TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_FEED = 40;
const OUTPUT_PER_CATEGORY = 10;
const FRESH_WINDOW_HOURS = 48;

// ===== 工具函数 =====
function timeoutSignal(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchText(url) {
  const res = await fetch(url, { signal: timeoutSignal(TIMEOUT_MS), headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } });
  if (!res.ok) return '';
  const text = await res.text();
  return text && text.length > 50 ? text : '';
}

function stripHtml(html) {
  let t = String(html || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;[^&]*&gt;/g, ' ')     // 先去掉实体编码的 HTML 标签（如 &lt;a href="..."&gt;）
    .replace(/<[^>]*>/g, ' ')          // 再去掉原始 HTML 标签
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    // 某些 RSS 把 iframe 等标签实体编码；解码后必须再清理一遍。
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉只剩空字符串或纯 URL 的摘要（Google News 常有只有链接的情况）
  if (!t || /^https?:\/\//.test(t)) return '';
  return t;
}

function escapeXml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 提取 <item> 块（兼容 RSS 与 Atom 的 <entry>）
function extractBlocks(xml, tag) {
  const blocks = [];
  const re = new RegExp('<(' + tag + ')([^>]*)>([\\s\\S]*?)</\\1>', 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[3]);
  }
  return blocks;
}

function extractField(block, tag) {
  const re = new RegExp('<' + tag + '(?:[^>]*)>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = re.exec(block);
  return m ? m[1].trim() : '';
}

function extractAttr(block, tag, attr) {
  const re = new RegExp('<' + tag + '[^>]*\\b' + attr + '=["\']([^"\']*)["\']', 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}

function parseItems(xml) {
  // Atom: 优先 entry；RSS: item
  let blocks = extractBlocks(xml, 'entry');
  let isAtom = blocks.length > 0;
  if (!isAtom) blocks = extractBlocks(xml, 'item');
  if (!blocks.length) return [];

  return blocks.map(block => {
    let title = '', link = '', pubDate = '', description = '', source = '';
    if (isAtom) {
      title = extractField(block, 'title');
      link = extractAttr(block, 'link', 'href') || extractField(block, 'link');
      pubDate = extractField(block, 'published') || extractField(block, 'updated');
      description = extractField(block, 'summary') || extractField(block, 'content');
      source = extractField(block, 'author');
    } else {
      title = extractField(block, 'title');
      link = extractField(block, 'link');
      pubDate = extractField(block, 'pubDate');
      description = extractField(block, 'description');
      source = extractField(block, 'source');
    }
    const titleClean = stripHtml(title);
    const sourceClean = stripHtml(source);
    // Google News 的标题自带「 - 来源名」后缀，与 source 字段重复，剥离之
    const finalTitle = sourceClean && titleClean.endsWith(' - ' + sourceClean)
      ? titleClean.slice(0, titleClean.length - sourceClean.length - 3).trim()
      : titleClean;
    return { title: finalTitle, link: link.trim(), pubDate: stripHtml(pubDate), description: stripHtml(description).slice(0, 200), source: sourceClean };
  }).filter(i => i.title && i.title.length > 3 && i.link);
}

function parseDate(str) {
  if (!str) return null;
  const t = new Date(str).getTime();
  return isNaN(t) ? null : t;
}

function isFresh(ts) {
  if (!ts) return false;
  return (Date.now() - ts) / 3600000 <= FRESH_WINDOW_HOURS;
}

// 提取来源名称：Google News 的 item 里 source 为空时，用 link 域名映射
function extractSourceName(source, link) {
  if (source && source.length > 1 && source.length < 40) return source;
  try {
    const host = new URL(link).hostname.replace('www.', '');
    const map = {
      'zaobao.com.sg': '联合早报', 'bbci.co.uk': 'BBC中文', 'bbc.com': 'BBC中文',
      'rfi.fr': 'RFI中文', 'dw.com': '德国之声', 'ithome.com': 'IT之家',
      '36kr.com': '36氪', 'ifanr.com': '爱范儿', 'cls.cn': '财联社',
      'tmtpost.com': '钛媒体', 'news.google.com': 'Google新闻', 'google.com': 'Google新闻',
      'chinanews.com.cn': '中国新闻网', 'news.cn': '新华网',
    };
    for (const [k, v] of Object.entries(map)) {
      if (host.includes(k)) return v;
    }
    return host;
  } catch {
    return '网络来源';
  }
}

async function fetchFeed(url) {
  const xml = await fetchText(url);
  if (!xml) return [];
  return parseItems(xml);
}

// 判断标题是否更像“刚发生的事件”，而不是知识文章、评论或生活方式内容。
// 这是排序信号而非绝对分类器：新鲜度与可靠来源仍会共同参与打分。
const EVENT_WORDS = /发布|通报|宣布|回应|启动|上线|获批|批准|签署|达成|发生|造成|新增|下调|上调|召回|立案|调查|逮捕|判处|宣判|公诉|被查|获刑|开幕|闭幕|举行|完成|首次|突破|发现|研发|报告|警报|预警|停运|恢复|取消|袭击|坠毁|地震|台风|火灾|爆炸|死亡|感染|确诊|融资|收购|上市|发射|部署|推出|更新/;
const ARTICLE_WORDS = /如何|为何|为什么|怎么办|是什么|有哪些|怎么选|这么选|一文|读懂|解读|观察|评论|专访|对话|手记|漫谈|指南|攻略|盘点|揭秘|真相|研报|提醒你|请查收|值得收藏|必看|小贴士|养生|科普|这些|这项|这种|很多人|每天|长期|竟会|别再|医生建议|专家支招|你知道吗|从.+到.+看/;
const HEALTH_WORDS = /医疗|医院|医生|患者|疾病|药|疫苗|医保|卫健委|卫生健康|药监|感染|病毒|细菌|手术|临床|医学|急救|公共卫生|健康/;

function newsScore(item, cat) {
  const ts = parseDate(item.pubDate) || 0;
  const ageHours = ts ? Math.max(0, (Date.now() - ts) / 3600000) : 999;
  let score = Number(item.feedWeight || 0) + Math.max(0, 48 - ageHours) * 2;
  if (EVENT_WORDS.test(item.title)) score += 28;
  if (ARTICLE_WORDS.test(item.title)) score -= 75;
  if (/[？?]|→|丨/.test(item.title)) score -= 12;
  if (item.title.length > 54) score -= 10;
  if (cat === '健康养生') {
    if (HEALTH_WORDS.test(item.title)) score += 18;
    if (/完成|获批|发布|通报|启动|新增|发现|召回|上市|签约|成立/.test(item.title)) score += 24;
    if (/减肥|减重|腰围|睡眠|饮食|吃什么|养肺|护眼|情绪|生活习惯/.test(item.title)) score -= 28;
    if (/展启幕|体验展|品牌|守护生命之光|医师节/.test(item.title)) score -= 55;
  }
  return score;
}

function categoryMatches(item, cat) {
  if (cat !== '健康养生') return true;
  return HEALTH_WORDS.test(item.title);
}

function storyNorm(title) {
  return normTitle(title)
    .replace(/医疗保障/g, '医保')
    .replace(/中华人民共和国|国家|官方|最新|今日|今天|正式|有关/g, '')
    .replace(/发布|宣布|通报|回应|消息|称/g, '');
}

function storySimilar(a, b, cat) {
  if (titleSimilar(a, b)) return true;
  const na = storyNorm(a), nb = storyNorm(b);
  if (na.length < 10 || nb.length < 10) return false;
  const grams = s => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const ga = grams(na), gb = grams(nb);
  let common = 0;
  for (const g of ga) if (gb.has(g)) common++;
  const ratio = common / Math.min(ga.size, gb.size);
  return cat === '健康养生'
    ? common >= 6 && ratio >= 0.38
    : common >= 8 && ratio >= 0.62;
}

function cleanSummary(item) {
  let summary = String(item.description || '').replace(/&nbsp;/g, ' ').trim();
  const titleNorm = normTitle(item.title);
  const summaryNorm = normTitle(summary);
  // Google News 的 description 通常只是“标题 + 来源”，不冒充摘要展示。
  if (!summary || summaryNorm === titleNorm || summaryNorm.startsWith(titleNorm) ||
      (titleNorm && summaryNorm.includes(titleNorm) && summary.length < item.title.length + 50)) {
    return '点击查看新闻详情';
  }
  return summary.slice(0, 160);
}

// 标题规范化：小写 + 去空格/标点/零宽字符，用于去重比较
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[\s\p{P}\uFEFF\u200B\u200C\u200D“”‘’«»]/gu, '');
}

// 保守去重：完全相等，或长串包含短串且长度差不超过 12 个字符（覆盖
// Google News 的「- 来源」后缀与标题截断变体）。不用相似度阈值，
// 避免误杀「XX国际局势第1/2/3…部分」这类仅序号不同的系列新闻。
function titleSimilar(a, b) {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length > nb.length && na.includes(nb)) return na.length - nb.length <= 12;
  if (nb.length > na.length && nb.includes(na)) return nb.length - na.length <= 12;
  return false;
}

// ===== 主流程 =====
async function main() {
  console.log('[fetch-news] 开始抓取 ' + new Date().toISOString());
  const results = [];
  const failedCats = [];
  let totalFetched = 0;

  for (const [cat, feeds] of Object.entries(RSS_FEEDS)) {
    const all = [];
    for (const feed of feeds) {
      const url = typeof feed === 'string' ? feed : feed.url;
      try {
        const items = (await fetchFeed(url)).slice(0, MAX_ITEMS_PER_FEED).map(item => ({
          ...item,
          feedWeight: typeof feed === 'string' ? 0 : feed.weight,
        }));
        if (items.length) {
          console.log(`  [${cat}] ${url} → ${items.length} 条`);
          all.push(...items);
        }
      } catch (e) {
        console.log(`  [${cat}] ${url} → 失败: ${e.message}`);
      }
    }

    // 去重（相似标题合并，保留靠前的一条）
    const unique = [];
    for (const i of all) {
      if (unique.some(u => titleSimilar(u.title, i.title))) continue;
      unique.push(i);
    }

    // 只展示 48 小时内且分类匹配的内容，再按“事件性 + 来源 + 新鲜度”排序。
    // 对国内/健康尤其宁缺毋滥，避免旧稿和养生文章凑数。
    const eligible = unique.filter(i => {
      const ts = parseDate(i.pubDate);
      return ts && isFresh(ts) && categoryMatches(i, cat);
    });
    eligible.sort((a, b) => newsScore(b, cat) - newsScore(a, cat) ||
      (parseDate(b.pubDate) || 0) - (parseDate(a.pubDate) || 0));

    const selected = [];
    const sourceCounts = new Map();
    const maxPerSource = cat === '健康养生' ? 5 : OUTPUT_PER_CATEGORY;
    for (const item of eligible) {
      if (cat === '健康养生' && newsScore(item, cat) < 95) continue;
      if (results.some(r => r.url === item.link)) continue;
      if (selected.some(s => storySimilar(s.title, item.title, cat))) continue;
      const source = extractSourceName(item.source, item.link);
      if ((sourceCounts.get(source) || 0) >= maxPerSource) continue;
      selected.push(item);
      sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
      if (selected.length >= OUTPUT_PER_CATEGORY) break;
    }

    const items = selected.map(i => {
      const ts = parseDate(i.pubDate) || 0;
      const d = ts ? new Date(ts) : null;
      const time = d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : '';
      return {
        cat,
        title: i.title,
        summary: cleanSummary(i),
        source: extractSourceName(i.source, i.link),
        url: i.link,
        time,
        _ts: ts,
        _isFresh: isFresh(ts),
      };
    });

    if (items.length) {
      results.push(...items);
      totalFetched += items.length;
    } else {
      failedCats.push(cat);
    }
  }

  console.log(`[fetch-news] 抓取完成：${totalFetched} 条，失败分类：${failedCats.join('、') || '无'}`);

  // 写文件（带换行符，方便 git diff）。不设最低条数门槛：抓多少写多少，宁可少也不留旧数据。
  const outPath = path.join(__dirname, 'news.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n', 'utf8');
  console.log(`[fetch-news] 已写入 ${outPath}（${results.length} 条）`);
}

main().catch(e => {
  console.error('[fetch-news] 异常退出:', e.message);
  process.exit(1);
});
