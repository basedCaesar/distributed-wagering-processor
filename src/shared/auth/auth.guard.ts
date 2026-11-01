import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
// biome-ignore lint/style/useImportType: NestJS resolve a injeção pelo tipo do construtor em runtime
import { Reflector } from "@nestjs/core";
import { ForbiddenError, UnauthenticatedError } from "../errors/app-errors";
import {
  type AuthenticatedRequest,
  IS_PUBLIC,
  REQUIRED_ROLES,
} from "./auth.decorators";
import {
  PROVIDER_IDENTITY,
  type ProviderIdentityPort,
  type Role,
} from "./provider-identity.port";

const BEARER = /^Bearer ([^\s]+)$/;

/**
 * Guard global (D10.4): tudo exige token, menos o que é `@Public()`. Roda
 * antes da validação do schema (zod, no controller), então sem token e com
 * corpo fora do schema é `401`. O parse do JSON é anterior ao guard: JSON
 * mal formado responde `400` mesmo sem token (D16.15).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = BEARER.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) throw new UnauthenticatedError();

    const identity = await this.identities.authenticate(token);
    request.identity = identity;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      REQUIRED_ROLES,
      targets,
    );
    if (required && !required.some((role) => identity.roles.has(role))) {
      throw new ForbiddenError();
    }
    return true;
  }
}
