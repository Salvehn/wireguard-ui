export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type UpdateState = {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  error: string;
  supported: boolean;
};
