import type { Request, Response, NextFunction } from "express";

/** Injects teamFilter into res.locals based on the requesting user's team assignment */
export function teamFilterMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    next();
    return;
  }

  if (user.team === "both") {
    // allow explicit team filter param from query
    const qTeam = req.query["team"] as string | undefined;
    res.locals.teamFilter = qTeam && ["residential", "public"].includes(qTeam) ? qTeam : undefined;
  } else {
    res.locals.teamFilter = user.team;
  }

  next();
}

export function getTeamFilter(res: Response): { team?: string } {
  const tf = res.locals.teamFilter as string | undefined;
  return tf ? { team: tf } : {};
}
