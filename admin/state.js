/** Mutable state shared by the admin entrypoint and feature modules. */
import { DEFAULT_SESSION_POLICY } from '../db/database.js?v=record-time-1';

export const feature = document.body.dataset.feature;
export const state = {
  session: { authenticated: false },
  busy: false,
  viewSequence: 0,
  letters: [],
  results: [],
  challenges: [],
  sessionPolicy: { ...DEFAULT_SESSION_POLICY },
  config: undefined,
  letterPage: 1,
  resultPage: 1,
  letterCursors: [null],
  resultCursors: [null],
  letterNext: null,
  resultNext: null,
  letterHasNext: false,
  resultHasNext: false,
  selectedLetters: new Set(),
  letterFilter: { query: '', status: feature === 'welcome' ? 'approved' : '', sort: 'desc' },
  resultFilter: { query: '', version: null, view: 'ranking' },
  renderedHash: location.hash,
  savedForms: new WeakMap(),
  listCache: new Map(),
};
