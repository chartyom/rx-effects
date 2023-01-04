import { Observable, Subscriber } from 'rxjs';
import { Controller } from './controller';
import { Query, QueryOptions } from './query';
import { mapQuery } from './queryMappers';
import { STORE_EVENT_BUS } from './storeEvents';
import { setInternalStoreFlag, setStateMutationName } from './storeMetadata';
import { DEFAULT_COMPARATOR, isReadonlyArray } from './utils';

let STORE_SEQ_NUMBER = 0;

/**
 * A function to update a state.
 *
 * It is recommended to return a new state or the previous one.
 *
 * Actually, the function can change the state in place, but it is responsible
 * for a developer to provide `comparator` function to the store which handles
 * the changes.
 *
 * For making changes use a currying function to provide arguments:
 * ```ts
 * const addPizzaToCart = (name: string): StateMutation<Array<string>> =>
 *   (state) => ([...state, name]);
 * ```
 *
 * @param state a previous state
 * @returns a next state
 */
export type StateMutation<State> = (state: State) => State;

/**
 * A record of factories which create state mutations.
 */
export type StateUpdates<State> = Readonly<
  Record<string, (...args: any[]) => StateMutation<State>>
>;

/**
 * Declare a record of factories for creating state mutations.
 */
export function declareStateUpdates<State>(): <
  Updates extends StateUpdates<State> = StateUpdates<State>,
>(
  updates: Updates,
) => Updates;

/**
 * Declare a record of factories for creating state mutations.
 */
export function declareStateUpdates<
  State,
  Updates extends StateUpdates<State> = StateUpdates<State>,
>(stateExample: State, updates: Updates): Updates;

export function declareStateUpdates<
  State,
  Updates extends StateUpdates<State> = StateUpdates<State>,
>(
  stateExample?: State,
  updates?: Updates,
):
  | Updates
  | (<Updates extends StateUpdates<State> = StateUpdates<State>>(
      updates: Updates,
    ) => Updates) {
  if (updates) {
    return updates;
  }

  return (updates) => updates;
}

/**
 * Returns a mutation which applies all provided mutations for a state.
 *
 * You can use this helper to apply multiple changes at the same time.
 */
export function pipeStateMutations<State>(
  mutations: ReadonlyArray<StateMutation<State>>,
): StateMutation<State> {
  return (state) =>
    mutations.reduce((nextState, mutation) => mutation(nextState), state);
}

/**
 * Read-only interface of a store.
 */
export type StoreQuery<State> = Readonly<
  Query<State> & {
    /**
     * Returns a part of the state as `Observable`
     * The result observable produces distinct values by default.
     *
     * @example
     * ```ts
     * const state: StateReader<{form: {login: 'foo'}}> = // ...
     * const value$ = state.select((state) => state.form.login);
     * ```
     */
    select: <R, K = R>(
      selector: (state: State) => R,
      options?: QueryOptions<R, K>,
    ) => Observable<R>;

    /**
     * Returns a part of the state as `Query`.
     * The result query produces distinct values by default.
     *
     * @example
     * ```ts
     * const state: StateReader<{form: {login: 'foo'}}> = // ...
     * const query = state.query((state) => state.form.login);
     * ```
     * */
    query: <R, K = R>(
      selector: (state: State) => R,
      options?: QueryOptions<R, K>,
    ) => Query<R>;

    /**
     * Cast the store to a narrowed `Query` type.
     */
    asQuery: () => Query<State>;
  }
>;

/**
 * @internal
 * Updates the state by provided mutations
 * */
export type StoreUpdateFunction<State> = (
  mutation:
    | StateMutation<State>
    | ReadonlyArray<StateMutation<State> | undefined | null | false>,
) => void;

/** Function which changes a state of the store */
export type StoreUpdate<Args extends unknown[]> = (...args: Args) => void;

/** Record of store update functions */
export type StoreUpdates<
  State,
  Updates extends StateUpdates<State>,
> = Readonly<{
  [K in keyof Updates]: StoreUpdate<Parameters<Updates[K]>>;
}>;

/**
 * Store of a state
 */
export type Store<State> = Controller<
  StoreQuery<State> & {
    id: number;
    name?: string;

    /** Sets a new state to the store */
    set: (state: State) => void;

    /** Updates the store by provided mutations */
    update: StoreUpdateFunction<State>;

    /** Immediately emits a current state to store's subscribers */
    notify: () => void;
  }
>;

/** Store of a state with updating functions */
export type StoreWithUpdates<
  State,
  Updates extends StateUpdates<State>,
> = Readonly<Store<State> & { updates: StoreUpdates<State, Updates> }>;

type StateMutationQueue<State> = ReadonlyArray<
  StateMutation<State> | undefined | null | false
>;

export type StoreOptions<State> = Readonly<{
  name?: string;

  /** A comparator for detecting changes between old and new states */
  comparator?: (prevState: State, nextState: State) => boolean;

  /** Callback is called when the store is destroyed */
  onDestroy?: () => void;
}>;

/** @internal */
export type InternalStoreOptions<State> = Readonly<
  StoreOptions<State> & { internal?: boolean }
>;

const NOTIFY_QUEUE: Set<Store<any>> = new Set();

/**
 * Creates the state store.
 *
 * @param initialState Initial state
 * @param options Parameters for the store
 */
export function createStore<State>(
  initialState: State,
  options?: StoreOptions<State>,
): Store<State> {
  const stateComparator = options?.comparator ?? DEFAULT_COMPARATOR;

  let currentState = initialState;
  const subscribers: Set<Subscriber<State>> = new Set();

  const store: Store<State> = {
    id: ++STORE_SEQ_NUMBER,
    name: options?.name,

    value$: new Observable<State>((subscriber) => {
      subscribers.add(subscriber);
      subscriber.next(currentState);

      return () => subscribers.delete(subscriber);
    }),

    get(): State {
      return currentState;
    },

    select<R, K = R>(
      selector: (state: State) => R,
      options?: QueryOptions<R, K>,
    ): Observable<R> {
      return this.query(selector, options).value$;
    },

    query<R, K = R>(
      selector: (state: State) => R,
      options?: QueryOptions<R, K>,
    ): Query<R> {
      return mapQuery(this, selector, options);
    },

    asQuery: () => store,

    set(nextState: State) {
      update(() => nextState);
    },

    update,

    notify() {
      const pinnedState = currentState;
      subscribers.forEach((subscriber) => subscriber.next(pinnedState));
    },

    destroy() {
      subscribers.forEach((subscriber) => subscriber.complete());
      subscribers.clear();

      STORE_EVENT_BUS.next({ type: 'destroyed', store });

      options?.onDestroy?.();
    },
  };

  function update(
    mutation:
      | StateMutation<State>
      | ReadonlyArray<StateMutation<State> | undefined | null | false>,
  ) {
    const prevState = currentState;

    const nextState = isReadonlyArray(mutation)
      ? applyMutations(currentState, mutation)
      : applyMutation(currentState, mutation);

    if (stateComparator(prevState, nextState)) {
      return;
    }

    currentState = nextState;
    scheduleNotify(store);

    STORE_EVENT_BUS.next({
      type: 'updated',
      store,
      nextState,
      prevState,
    });
  }

  function applyMutations(
    state: State,
    mutations: StateMutationQueue<State>,
  ): State {
    let nextState = state;

    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];
      if (mutation) {
        nextState = applyMutation(nextState, mutation);
      }
    }

    return nextState;
  }

  function applyMutation(state: State, mutation: StateMutation<State>): State {
    const nextState = mutation(state);

    STORE_EVENT_BUS.next({
      type: 'mutation',
      store,
      mutation,
      nextState,
      prevState: state,
    });

    return nextState;
  }

  if ((options as InternalStoreOptions<State> | undefined)?.internal) {
    setInternalStoreFlag(store);
  }

  STORE_EVENT_BUS.next({ type: 'created', store });

  return store;
}

function scheduleNotify(store: Store<any>) {
  if (NOTIFY_QUEUE.add(store).size === 1) {
    Promise.resolve().then(executeNotifyQueue);
  }
}

function executeNotifyQueue() {
  const queue = [...NOTIFY_QUEUE];
  NOTIFY_QUEUE.clear();
  queue.forEach((store) => store.notify());
}

/** Creates StateUpdates for updating the store by provided state mutations */
export function createStoreUpdates<State, Updates extends StateUpdates<State>>(
  storeUpdate: Store<State>['update'],
  stateUpdates: Updates,
): StoreUpdates<State, Updates> {
  const updates: any = {};

  Object.entries(stateUpdates).forEach(([key, mutationFactory]) => {
    (updates as any)[key] = (...args: any[]) => {
      const mutation = mutationFactory(...args);
      setStateMutationName(mutation, key);

      storeUpdate(mutation);
    };
  });

  return updates;
}

/** Creates a proxy for the store with "updates" to change a state by provided mutations */
export function withStoreUpdates<
  State,
  Updates extends StateUpdates<State> = StateUpdates<State>,
>(store: Store<State>, updates: Updates): StoreWithUpdates<State, Updates> {
  const storeUpdates: StoreUpdates<State, Updates> = createStoreUpdates<
    State,
    Updates
  >(store.update, updates);

  return { ...store, updates: storeUpdates };
}
