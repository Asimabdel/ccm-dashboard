import { toast } from "sonner";
import { useLocation } from "wouter";
import { Loader2, MessageSquareText } from "lucide-react";
import { Btn } from "@/components/workspace/ui";
import { trpc } from "@/lib/trpc";

/** Patient 360: open the texting conversation with this patient (Messages → Patient texts). Only when texting is on. */
export function TextPatientButton({ subjectKey }: { subjectKey: string }) {
  const [, navigate] = useLocation();
  const status = trpc.workspace.texts.status.useQuery(undefined, { staleTime: 60_000 });
  const open = trpc.workspace.texts.openForPatient.useMutation({
    onSuccess: (r) => navigate(`/messages?tab=texts&t=${r.id}`),
    onError: (e) => toast.error(e.message),
  });
  if (!status.data?.canUse || !status.data.enabled) return null;
  return (
    <Btn variant="secondary" disabled={open.isPending} onClick={() => open.mutate({ subjectKey })}>
      {open.isPending ? <Loader2 size={15} className="animate-spin" /> : <MessageSquareText size={15} />} Text
    </Btn>
  );
}
