import { describe, it, expect } from 'vitest';
import { edgeListSize, edgePrefix, parseEdgeList } from './edgeList';
import { GraphAdj } from '../structures/graph';
import type { GraphData } from './graphs';

function twin(g: GraphData): GraphAdj {
  return GraphAdj.fromEdges(Array.from(g.edges), g.numVertices);
}

/**
 * Edge-list import (docs/METHODOLOGY.md §2.7). Each test below pins one of the PLAN §10
 * traps the import exists to avoid, or the "never dedupe" rule.
 */
describe('parseEdgeList', () => {
  it('maps labels to dense ids in first-seen order, so vertex 0 is always real (trap 2)', () => {
    // Raw numeric ids would make vertex 0 an id the file never mentions: V = 4, and a
    // traversal from 0 would reach one isolated vertex for one vertex-visit — a flat O(1)
    // line charted from a three-vertex path.
    const list = parseEdgeList('1,2\n2,3\n');
    expect(list.labels).toEqual(['1', '2', '3']);
    expect(Array.from(list.edges)).toEqual([0, 1, 1, 2]);
    const g = edgePrefix(list, edgeListSize(list));
    expect(g.numVertices).toBe(3);
    const t = twin(g).bfs(0);
    expect(t.reached).toBe(3);
    expect(t.ops).toBe(3 + 2 * 2);
  });

  it('treats labels as text, never numbers — 02134 is not 2134, 1.0 is not 1 (trap 3)', () => {
    const list = parseEdgeList('02134,2134\n1.0,1\n 2134 ,x\n');
    expect(list.labels).toEqual(['02134', '2134', '1.0', '1', 'x']);
    // Surrounding whitespace is trimmed, so " 2134 " is the same vertex as "2134".
    expect(Array.from(list.edges)).toEqual([0, 1, 2, 3, 1, 4]);
    expect(list.selfLoops).toBe(0);
  });

  it('hands the twin integer ids in range (trap 3, the adjLists[1.5] half)', () => {
    const list = parseEdgeList('a,b\nb,c\nc,a\nd,e\n');
    const ids = Array.from(list.edges);
    expect(ids.every((id) => Number.isInteger(id) && id >= 0 && id < list.labels.length)).toBe(true);
  });

  it('keeps parallel edges and self-loops (never dedupe)', () => {
    const list = parseEdgeList('a,b\na,b\nb,a\nc,c\nb,c\n');
    expect(edgeListSize(list)).toBe(5);
    expect(list.selfLoops).toBe(1);
    const g = edgePrefix(list, 5);
    // V' = 3, E' = 5 (three parallel a–b edges, one loop on c, b–c): 3 + 2·5.
    expect(twin(g).bfs(0).ops).toBe(3 + 10);
  });

  it('skips blanks and comments, counts short lines and extra columns, honours a header', () => {
    const text = [
      '# a SNAP-style comment',
      'source,target,weight',
      '',
      'a,b,0.5',
      'lonely',
      'b,c',
      'c,',
    ].join('\r\n');
    const list = parseEdgeList(text, { header: true });
    expect(list.labels).toEqual(['a', 'b', 'c']);
    expect(edgeListSize(list)).toBe(2);
    expect(list.skippedLines).toBe(2); // "lonely" and "c,"
    expect(list.extraColumnLines).toBe(1); // the weight column
    // Without the header flag the header line is an edge like any other — never guessed.
    expect(parseEdgeList(text).labels.slice(0, 2)).toEqual(['source', 'target']);
    // And with comments off, a label may really start with '#'.
    expect(parseEdgeList('#1,#2\n', { commentPrefix: null }).labels).toEqual(['#1', '#2']);
  });

  it('reads tab- and whitespace-separated lists, quoted CSV fields, and a BOM', () => {
    expect(parseEdgeList('a\tb\nb\tc\n', { delimiter: 'tab' }).labels).toEqual(['a', 'b', 'c']);
    const ws = parseEdgeList('# FromNodeId ToNodeId\n0   1\n1 2\n\n2\t0\n', { delimiter: 'whitespace' });
    expect(ws.labels).toEqual(['0', '1', '2']);
    expect(edgeListSize(ws)).toBe(3);
    expect(parseEdgeList('"New York, NY",Boston\n').labels).toEqual(['New York, NY', 'Boston']);
    expect(parseEdgeList('﻿a,b\n').labels).toEqual(['a', 'b']);
  });
});

describe('edgePrefix', () => {
  it('is prefix-stable: the first m edges use exactly ids 0..k−1', () => {
    const list = parseEdgeList('p,q\nr,s\nq,r\nt,p\n');
    const two = edgePrefix(list, 2);
    expect(two.numVertices).toBe(4);
    expect(Array.from(two.edges)).toEqual([0, 1, 2, 3]);
    expect(two.origin).toEqual({ kind: 'edge-list', edges: 2, totalEdges: 4 });
    expect(edgePrefix(list, 99).numVertices).toBe(5);
    expect(edgePrefix(list, 0).numVertices).toBe(0);
  });

  it('can be disconnected — a traversal then reaches only vertex 0’s component (trap 4)', () => {
    // The first two edges do not touch: from 0 the traversal reaches {p, q} only, so the
    // honest x-coordinate is V' + 2E' = 2 + 2, not the prefix's nominal 4 + 2·2.
    const list = parseEdgeList('p,q\nr,s\nq,r\n');
    const t = twin(edgePrefix(list, 2)).bfs(0);
    expect(t.reached).toBe(2);
    expect(t.ops).toBe(2 + 2 * 1);
  });

  it('copies its edges, so every prefix owns a transferable buffer', () => {
    const list = parseEdgeList('a,b\nb,c\nc,d\n');
    const a = edgePrefix(list, 2);
    const b = edgePrefix(list, 3);
    expect(a.edges.buffer).not.toBe(b.edges.buffer);
    expect(a.edges.buffer).not.toBe(list.edges.buffer);
  });
});
