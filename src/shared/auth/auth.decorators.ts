import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from "@nestjs/common";
import type { Request } from "express";
import type { Identity, Role } from "./provider-identity.port";

export const IS_PUBLIC = "auth:isPublic";
export const REQUIRED_ROLES = "auth:requiredRoles";

/** Sem token: health e `/docs` (R-02-06, D13.2). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Papéis aceitos (D10.2): basta ter um deles, então um token com os dois
 * papéis tem as permissões dos dois (D16.10). Sem `@Roles`, qualquer token
 * válido serve.
 */
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

export interface AuthenticatedRequest extends Request {
  identity?: Identity;
}

/** A identidade que o guard pôs na requisição. */
export const CurrentIdentity = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Identity | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().identity,
);
