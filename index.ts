import { ApplicationLifecycle } from "./packages/app/lifecycle";

/** 机器人进程生命周期单例。 */
export const application: ApplicationLifecycle = new ApplicationLifecycle();

if (import.meta.main) await application.run("main");
