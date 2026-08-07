// Shared types mirroring the backend's types.ts shapes
export interface TaskStep {
  id: string;
  label: string;
  capability: string;
  dependsOn: string[];
}

export interface TaskGraph {
  task_id: string;
  name: string;
  budget_cap: number;
  goal: string;
  steps: TaskStep[];
}

export interface GuardViolation {
  id: string;
  type: string;
  stage: string;
  message: string;
  rejected_fields: string[];
  at: string;
}
