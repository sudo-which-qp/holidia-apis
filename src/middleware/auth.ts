import jwt from "@elysiajs/jwt";
import Elysia, { error } from "elysia";
import { db } from "../db";
import bearer from "@elysiajs/bearer";

console.log(Bun.env.JWT_TOKEN, "token");

export const authPlugin = (app: Elysia) =>
  app
    .use(
      jwt({
        secret: Bun.env.JWT_TOKEN as string,
      })
    )
    .derive({ as: "local" }, async ({ jwt, headers, set }) => {
      console.log(JSON.stringify(headers, null, 2));
      const token = headers.authorization;
      console.log(token, "token");
      const payload = await jwt.verify(token);
      if (!payload) {
        return error(401, "Unauthorized");
      }
      console.log(payload, "payload");
      const user = await db.user.findUnique({
        where: {
          id: payload.sub as string,
        },
      });
      if (!user) {
        return error(401, "Unauthorized");
      }

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.avatar,
        },
      };
    });
