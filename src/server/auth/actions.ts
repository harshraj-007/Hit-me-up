"use server";

import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "@/server/errors";
import { requestMagicLink, signOutCurrentUser } from "@/server/services/auth";

export async function requestMagicLinkAction(formData: FormData): Promise<ActionResult<null>> {
  return runAction(async () => {
    await requestMagicLink({ email: formData.get("email") });
    return null;
  });
}

export async function signOutAction(): Promise<void> {
  await signOutCurrentUser();
  redirect("/login");
}
