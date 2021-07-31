import { Observable } from 'rxjs';
import { Action } from './action';
import { createEffect, Effect, EffectHandler, HandlerOptions } from './effect';

export function handleAction<Event, Result = void, ErrorType = Error>(
  source: Observable<Event> | Action<Event>,
  handler: EffectHandler<Event, Result>,
  options?: HandlerOptions<ErrorType>,
): Effect<Event, Result, ErrorType> {
  const effect = createEffect<Event, Result, ErrorType>(handler);
  effect.handle(source, options);

  return effect;
}
