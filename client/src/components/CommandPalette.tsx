import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import {
  KeyRound, LogOut, Database, ShieldCheck, User as UserIcon,
} from "lucide-react";
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from "@/components/ui/command";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { NAV, type Role } from "@/lib/nav";
import { useWorkspace } from "@/components/workspace/useWorkspace";
import { patientHref } from "@shared/folder";

/**
 * Global ⌘K / Ctrl+K command palette: jump to any page, search patients live,
 * and run quick actions. Mounted once in CCMDashboardLayout. Other components can
 * open it by dispatching a window "open-command-palette" event (the header search
 * button does this).
 */
export function CommandPalette() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  // ⌘K / Ctrl+K toggles; a custom event opens it (used by the header search button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  // Debounce the live patient search so we don't fire (and audit-log) a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const role = (user && user.role in NAV ? (user.role as Role) : "admin") as Role;
  const navItems = NAV[role] || [];
  const isAdmin = user?.role === "admin";

  // Everyone at the clinics (Patients list) for staff with the patient view; billing searches the CCM roster.
  const { caps } = useWorkspace();
  const everyone = !!caps?.flowView;
  const directoryQ = trpc.workspace.directory.list.useQuery(
    { q: debounced, status: "all", sort: "name", page: 1 },
    { enabled: open && debounced.length >= 2 && everyone }
  );
  const rosterQ = trpc.patients.list.useQuery(
    { search: debounced },
    { enabled: open && debounced.length >= 2 && !everyone && user?.role !== "medical_assistant" }
  );
  const patientsQ = everyone ? directoryQ : rosterQ;
  const patients = everyone
    ? (directoryQ.data?.rows ?? []).map((r) => ({ key: r.key, name: r.name, hint: [r.dob ? `DOB ${r.dob.slice(5, 7)}/${r.dob.slice(8, 10)}/${r.dob.slice(0, 4)}` : null, r.clinicName].filter(Boolean).join(" · "), phone: r.phone ?? "" }))
    : (rosterQ.data ?? []).map((row) => ({ key: `p:${row.patient.id}`, name: row.patient.name, hint: row.clinicName || row.patient.phoneNumber, phone: row.patient.phoneNumber }));

  const seed = trpc.admin.seed.useMutation({
    onSuccess: async (s) => {
      toast.success(`Seeded ${s.patients} patients and ${s.tasks} tasks.`);
      await utils.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const run = (fn: () => void) => {
    setOpen(false);
    setQuery("");
    fn();
  };

  if (!user) return null;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search patients, pages, actions…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>
          {patientsQ.isFetching ? "Searching…" : "No results found."}
        </CommandEmpty>

        <CommandGroup heading="Go to">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.path}
                value={`go ${item.label}`}
                onSelect={() => run(() => setLocation(item.path))}
              >
                <Icon />
                <span>{item.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        {patients.length > 0 && (
          <CommandGroup heading="Patients">
            {patients.slice(0, 8).map((row) => (
              <CommandItem
                key={row.key}
                value={`patient ${row.name} ${row.phone} ${debounced}`}
                onSelect={() => run(() => setLocation(everyone ? patientHref(row.key, "overview") : `/patients/${row.key.slice(2)}`))}
              >
                <UserIcon />
                <span>{row.name}</span>
                <span className="ml-auto text-xs text-muted-foreground truncate max-w-[45%]">{row.hint}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Actions">
          <CommandItem
            value="action change password"
            onSelect={() => run(() => setLocation("/change-password"))}
          >
            <KeyRound />
            <span>Change password</span>
          </CommandItem>
          {isAdmin && (
            <CommandItem
              value="action seed demo data"
              onSelect={() => run(() => seed.mutate())}
            >
              <Database />
              <span>Seed demo data</span>
            </CommandItem>
          )}
          {isAdmin && (
            <CommandItem
              value="action audit log"
              onSelect={() => run(() => setLocation("/audit"))}
            >
              <ShieldCheck />
              <span>Open audit log</span>
            </CommandItem>
          )}
          <CommandItem
            value="action sign out"
            onSelect={() =>
              run(async () => {
                await logout();
                setLocation("/");
              })
            }
          >
            <LogOut />
            <span>Sign out</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
