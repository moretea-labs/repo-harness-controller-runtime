import { RepoActor } from './actor';

export interface RepoActorRuntimeIdentity {
  controllerPid: number;
  controllerStartedAt?: string;
}

export class RepoActorRegistry {
  private readonly controllerHome: string;
  private readonly runtimeIdentity: RepoActorRuntimeIdentity;
  private readonly actors = new Map<string, RepoActor>();
  constructor(controllerHome: string, runtimeIdentity: RepoActorRuntimeIdentity) {
    this.controllerHome = controllerHome;
    this.runtimeIdentity = runtimeIdentity;
  }

  get(repoId: string): RepoActor {
    let actor = this.actors.get(repoId);
    if (!actor) {
      actor = new RepoActor(this.controllerHome, repoId, {
        maxConcurrentWorkers: Number(process.env.REPO_HARNESS_PER_REPO_WORKERS ?? 2),
        controllerPid: this.runtimeIdentity.controllerPid,
        controllerStartedAt: this.runtimeIdentity.controllerStartedAt,
      });
      this.actors.set(repoId, actor);
    }
    return actor;
  }
}
