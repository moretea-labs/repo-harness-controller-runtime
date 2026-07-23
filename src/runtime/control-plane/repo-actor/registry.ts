import { RepoActor } from './actor';

export class RepoActorRegistry {
  private readonly controllerHome: string;
  private readonly actors = new Map<string, RepoActor>();
  constructor(controllerHome: string) {
    this.controllerHome = controllerHome;
  }

  get(repoId: string): RepoActor {
    let actor = this.actors.get(repoId);
    if (!actor) {
      actor = new RepoActor(this.controllerHome, repoId, {
        maxConcurrentWorkers: Number(process.env.REPO_HARNESS_PER_REPO_WORKERS ?? 2),
      });
      this.actors.set(repoId, actor);
    }
    return actor;
  }
}
