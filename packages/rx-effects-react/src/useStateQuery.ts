import { useEffect, useState } from 'react';
import { StateQuery } from 'rx-effects';

export function useStateQuery<T>(query: StateQuery<T>): T {
  const [value, setValue] = useState<T>(() => query.get());

  useEffect(() => {
    const subscription = query.value$.subscribe((nextValue) => {
      setValue(nextValue);
    });

    return () => subscription.unsubscribe();
  }, [query.value$]);

  return value;
}
