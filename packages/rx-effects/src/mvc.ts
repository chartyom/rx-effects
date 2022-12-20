import { Container, injectable, Token } from 'ditox';
import { Controller } from './controller';
import { createScope, Scope } from './scope';
import { AnyObject } from './utils';

export function createController<Service extends AnyObject>(
  factory: (scope: Scope) => Service & { destroy?: () => void },
): Controller<Service> {
  const scope = createScope();

  const controller = factory(scope);

  return {
    ...controller,

    destroy: () => {
      controller.destroy?.();
      scope.destroy();
    },
  };
}

export type ControllerFactory<Service extends AnyObject> = (
  container: Container,
) => Controller<Service>;

export type InferredService<Factory> = Factory extends ControllerFactory<
  infer Service
>
  ? Service
  : never;

declare type DependencyProps = {
  [key: string]: unknown;
};

declare type TokenProps<Props extends DependencyProps> = {
  [K in keyof Props]: Token<Props[K]>;
};

export function declareController<
  Dependencies extends DependencyProps,
  Service extends AnyObject,
>(
  tokens: TokenProps<Dependencies>,
  factory: (deps: Dependencies, scope: Scope) => Service,
): ControllerFactory<Service> {
  return injectable(
    (deps) => createController((scope) => factory(deps as Dependencies, scope)),
    tokens,
  );
}

export type ViewControllerFactory<
  Service extends AnyObject,
  Params extends unknown[],
> = (container: Container, ...params: Params) => Controller<Service>;

export function declareViewController<
  Service extends AnyObject,
  Params extends unknown[],
>(
  factory: (scope: Scope, ...params: Params) => Service,
): ViewControllerFactory<Service, Params>;

export function declareViewController<
  Dependencies extends DependencyProps,
  Service extends AnyObject,
  Params extends unknown[],
>(
  tokens: TokenProps<Dependencies>,
  factory: (
    deps: Dependencies,
    scope: Scope,
  ) => Service | ((scope: Scope, ...params: Params) => Service),
): ViewControllerFactory<Service, Params>;

export function declareViewController<
  Dependencies extends DependencyProps,
  Service extends AnyObject,
  Params extends unknown[],
  Factory extends (
    deps: Dependencies,
    scope: Scope,
  ) => Service | ((scope: Scope, ...params: Params) => Service),
>(
  tokensOrFactory: TokenProps<Dependencies> | Factory,
  factory?: Factory,
): ViewControllerFactory<Service, Params> {
  const factoryValue = (factory ?? tokensOrFactory) as Factory;

  const tokensValue = (
    factory ? tokensOrFactory : {}
  ) as TokenProps<Dependencies>;

  return (container: Container, ...params: Params) => {
    return injectable((dependencies) => {
      return createController((scope) => {
        const result = factoryValue(dependencies as Dependencies, scope);

        if (typeof result === 'function') {
          return result(scope, ...params);
        } else {
          return result;
        }
      });
    }, tokensValue)(container);
  };
}