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

// ===== RSS Feed 配置（与前端一致，主力为 Google News RSS）=====
const RSS_FEEDS = {
  '国内要闻': [
    'https://news.google.com/rss/search?q=%E4%B8%AD%E5%9B%BD+%E8%A6%81%E9%97%BB+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    'https://www.zaobao.com.sg/rss/realtime/china.xml',
    'https://www.zaobao.com.sg/rss/zg.xml',
  ],
  '科技前沿': [
    'https://news.google.com/rss/search?q=AI+%E7%A7%91%E6%8A%80+%E5%89%8D%E6%B2%BF+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    'https://www.ithome.com/rss/',
    'https://36kr.com/feed',
  ],
  '经济金融': [
    'https://news.google.com/rss/search?q=%E7%BB%8F%E6%B5%8E+%E9%87%91%E8%9E%8D+%E8%82%A1%E5%B8%82+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    'https://www.cls.cn/feed',
  ],
  '国际局势': [
    'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml',
    'https://news.google.com/rss/search?q=%E5%9B%BD%E9%99%85+%E5%B1%80%E5%8A%BF+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    'https://www.rfi.fr/cn/rss',
  ],
  '争议新闻': [
    'https://news.google.com/rss/search?q=%E7%A4%BE%E4%BC%9A+%E7%83%AD%E7%82%B9+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    'https://www.zaobao.com.sg/rss/forum.xml',
  ],
  '健康养生': [
    'https://news.google.com/rss/search?q=%E5%81%A5%E5%BA%B7+%E5%85%BB%E7%94%9F+%E5%8C%BB%E5%AD%A6+when:2d&hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
    'https://www.zaobao.com.sg/rss/lifestyle.xml',
  ],
};

const TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_CATEGORY = 12;
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
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉纯 URL 或只剩空字符串的摘要（Google News 常有只有链接的情况）
  if (!t || t.length <= 8 || /^https?:\/\//.test(t)) return '';
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
    return { title: finalTitle, link: stripHtml(link), pubDate: stripHtml(pubDate), description: stripHtml(description).slice(0, 200), source: sourceClean };
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
    for (const url of feeds) {
      try {
        const items = await fetchFeed(url);
        if (items.length) {
          console.log(`  [${cat}] ${url} → ${items.length} 条`);
          all.push(...items);
        }
      } catch (e) {
        console.log(`  [${cat}] ${url} → 失败: ${e.message}`);
      }
      if (all.length >= MAX_ITEMS_PER_CATEGORY) break;
    }

    // 去重（相似标题合并，保留靠前的一条）
    const unique = [];
    for (const i of all) {
      if (unique.some(u => titleSimilar(u.title, i.title))) continue;
      unique.push(i);
    }

    // 排序：新鲜优先，其次时间倒序
    unique.sort((a, b) => {
      const ta = parseDate(a.pubDate) || 0;
      const tb = parseDate(b.pubDate) || 0;
      return tb - ta;
    });

    const items = unique.slice(0, OUTPUT_PER_CATEGORY).map(i => {
      const ts = parseDate(i.pubDate) || 0;
      const d = ts ? new Date(ts) : null;
      const time = d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : '';
      return {
        cat,
        title: i.title,
        summary: i.description || '暂无摘要',
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
