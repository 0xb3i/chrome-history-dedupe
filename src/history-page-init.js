// Loading saved preferences must not take ownership back from a user's draft or
// submission. The initial search always uses saved conditions, never a draft.
export function createHistoryPageInitializer({ initialSearch, load, apply, restore, search }) {
  let edited = false;
  let submitted = false;
  const defaultSearch = { ...initialSearch };

  return {
    markEdited() { edited = true; },
    markSubmitted() { submitted = true; },
    async initialize() {
      const preferences = await load();
      const savedSearch = preferences.lastSearchState ?? defaultSearch;
      apply(preferences);
      if (!edited && !submitted) restore(savedSearch);
      if (!submitted) await search(savedSearch.query, savedSearch.range);
    }
  };
}
