// The batch cap shared by Tailor and Apply: how many workers run in flight at once, one per
// Application. Neutral so neither command imports the other.

/** How many workers Tailor and Apply keep in flight at once, one per Application. */
export const BATCH_SIZE = 3;
