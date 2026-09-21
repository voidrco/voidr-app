import { TypeSafeClient } from "@typesafe-ai/sdk";

export function createTypeSafeClient() {
  if (!process.env.TYPESAFE_API_KEY?.trim()) {
    throw new Error("Configure TYPESAFE_API_KEY em .env.staging.");
  }

  return new TypeSafeClient({ logLevel: "off" });
}
