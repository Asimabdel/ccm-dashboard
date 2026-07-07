import { Sunrise, Sun, MoonStar } from "lucide-react";
import { dailyEncouragement, greetingForNow, firstNameOf } from "@/lib/encouragement";

/**
 * Warm daily greeting for a coordinator's dashboard. The message rotates
 * once per day and is unique to the user; the stat line makes it personal.
 */
export function DailyEncouragement({ userId, name, completedToday, completedMonth }: {
  userId: number;
  name?: string | null;
  completedToday?: number;
  completedMonth?: number;
}) {
  const now = new Date();
  const greeting = greetingForNow(now);
  const Icon = now.getHours() < 12 ? Sunrise : now.getHours() < 17 ? Sun : MoonStar;

  const stat =
    (completedToday ?? 0) > 0
      ? `You've already completed ${completedToday} today — keep it rolling.`
      : (completedMonth ?? 0) > 0
        ? `${completedMonth} patients cared for this month so far.`
        : null;

  return (
    <div className="rounded-3xl border border-[hsl(22_64%_88%)] bg-[hsl(26_70%_96%)] px-6 py-5 flex items-start gap-4">
      <span className="mt-0.5 w-10 h-10 rounded-2xl bg-[hsl(22_64%_93%)] text-[hsl(17_66%_47%)] flex items-center justify-center shrink-0">
        <Icon size={20} />
      </span>
      <div className="min-w-0">
        <p className="font-bold text-slate-900">{greeting}, {firstNameOf(name)}.</p>
        <p className="text-sm text-slate-600 mt-0.5">{dailyEncouragement(userId, now)}</p>
        {stat && <p className="text-xs font-semibold text-[hsl(17_66%_47%)] mt-1.5">{stat}</p>}
      </div>
    </div>
  );
}
