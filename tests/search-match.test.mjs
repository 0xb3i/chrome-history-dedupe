import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPinnedStateToGroups,
  filterHistoryItemsByQuery,
  groupHistoryItems,
  prepareHistoryItemsForSearch
} from '../src/history-utils.js';

function highlights(text, ranges) {
  return ranges.map(([start, end]) => text.slice(start, end));
}

test('matching copies results without mutating prepared facts and leaves empty queries untouched', () => {
  const items = prepareHistoryItemsForSearch([{ title: 'Atlas Guide', url: 'https://example.com/atlas' }]);
  const snapshot = structuredClone(items);
  const [result] = filterHistoryItemsByQuery(items, 'Atlas');
  assert.notEqual(result, items[0]);
  assert.deepEqual(result.searchMatch.titleRanges, [[0, 5]]);
  assert.deepEqual(result.searchMatch.aliases, []);
  assert.deepEqual(items, snapshot);
  assert.equal(filterHistoryItemsByQuery(items, ' \u200b '), items);
});

test('match evidence explains each keyword across displayed and historical titles', () => {
  const item = {
    title: 'Atlas Dashboard',
    searchableTitles: ['Original Engineering Report', 'Legacy Summary', 'Other Engineering Guide'],
    url: 'https://example.com/'
  };
  const [result] = filterHistoryItemsByQuery([item], 'atlas report legacy');
  assert.deepEqual(highlights(item.title, result.searchMatch.titleRanges), ['Atlas']);
  assert.deepEqual(result.searchMatch.aliases, [
    { text: 'Original Engineering Report', ranges: [[21, 27]] },
    { text: 'Legacy Summary', ranges: [[0, 6]] }
  ]);
  assert.deepEqual(filterHistoryItemsByQuery([item], 'atlas report absent'), []);
});

test('aliases are omitted when the displayed title already explains all keywords', () => {
  const [result] = filterHistoryItemsByQuery([{
    title: 'Atlas Guide', searchableTitles: ['Atlas Old Guide', 'Ａｔｌａｓ Guide']
  }], 'atlas guide');
  assert.deepEqual(result.searchMatch.aliases, []);
});

test('normalization maps compatibility forms, combining marks and astral characters back to original UTF-16', () => {
  const title = '  😀 ＡＴＬＡＳ\u200b  Cafe\u0301\t\tﬃ  ';
  const [result] = filterHistoryItemsByQuery([{ title }], 'atlas café ffi');
  assert.deepEqual(highlights(title, result.searchMatch.titleRanges), ['ＡＴＬＡＳ', 'Cafe\u0301', 'ﬃ']);
  const [emoji] = filterHistoryItemsByQuery([{ title }], '😀');
  assert.deepEqual(emoji.searchMatch.titleRanges, [[2, 4]]);
  const [expanded] = filterHistoryItemsByQuery([{ title: 'İstanbul ㍿' }], 'i 株式会社');
  assert.deepEqual(highlights('İstanbul ㍿', expanded.searchMatch.titleRanges), ['İ', '㍿']);
  const [composed] = filterHistoryItemsByQuery([{ title: 'ㄱㅏ Guide ΟΣ' }], '가 guide ος');
  assert.deepEqual(highlights(composed.title, composed.searchMatch.titleRanges), ['ㄱㅏ', 'Guide', 'ΟΣ']);
});

test('normalized whitespace and invisible controls preserve alias evidence offsets', () => {
  const text = 'Old\u200b\t\tName';
  const [result] = filterHistoryItemsByQuery([{ title: 'New Name', searchableTitles: [text] }], 'old name');
  assert.deepEqual(result.searchMatch.aliases, [{ text, ranges: [[0, 3]] }]);
  assert.deepEqual(result.searchMatch.titleRanges, [[4, 8]]);
  const [hiddenControl] = filterHistoryItemsByQuery([{ title: 'At\u200blas' }], 'atlas');
  assert.deepEqual(hiddenControl.searchMatch.titleRanges, [[0, 6]]);
});

test('bounded Chinese shorthand highlights matched characters and respects the skip limit', () => {
  const title = '大语言模型知识面试一本通';
  const [result] = filterHistoryItemsByQuery([{ title }], '大模型');
  assert.deepEqual(highlights(title, result.searchMatch.titleRanges), ['大', '模型']);
  assert.deepEqual(filterHistoryItemsByQuery([{ title }], '大面试'), []);
  const astral = '𠀀一二𠀁三𠀂';
  const [astralResult] = filterHistoryItemsByQuery([{ title: astral }], '𠀀𠀁𠀂');
  assert.deepEqual(highlights(astral, astralResult.searchMatch.titleRanges), ['𠀀', '𠀁', '𠀂']);
});

test('only real titles match, including when a displayed fallback or historical alias is a URL', () => {
  assert.deepEqual(filterHistoryItemsByQuery([{
    title: 'https://example.com/atlas',
    historyTitle: 'www.example.com/atlas',
    searchableTitles: ['file:///atlas'],
    url: 'https://example.com/atlas'
  }], 'atlas'), []);
});

test('exact title outranks title phrases, shorthand and aliases while pins keep explicit order', () => {
  const items = [
    { id: 'alias', title: 'Old document', searchableTitles: ['大模型'], visitCount: 900, isTitleRenamed: true },
    { id: 'shorthand', title: '大语言模型', visitCount: 800 },
    { id: 'phrase', title: '大模型周会', visitCount: 700 },
    { id: 'exact', title: '大模型', visitCount: 1 },
    { id: 'pin-first', title: '大语言模型', visitCount: 1 },
    { id: 'pin-second', title: '大模型', visitCount: 1000 }
  ].map((item) => ({ ...item, url: `https://example.com/${item.id}` }));
  const groups = applyPinnedStateToGroups(groupHistoryItems(filterHistoryItemsByQuery(items, '大模型')), [
    'https://example.com/pin-first', 'https://example.com/pin-second'
  ]);
  assert.deepEqual(groups[0].items.map((item) => item.id), ['pin-first', 'pin-second', 'exact', 'phrase', 'shorthand', 'alias']);
  assert.deepEqual(groupHistoryItems(items)[0].items.slice(0, 2).map((item) => item.id), ['alias', 'pin-second']);
});

test('all occurrences are highlighted with repeated and overlapping query evidence merged', () => {
  const [result] = filterHistoryItemsByQuery([{ title: 'Atlas atlas' }], 'atlas at atlas');
  assert.deepEqual(result.searchMatch.titleRanges, [[0, 5], [6, 11]]);
});
