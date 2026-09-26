import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import AdminDashboard from "./pages/AdminDashboard";
import CoordinatorDashboard from "./pages/CoordinatorDashboard";
import PatientsPage from "./pages/PatientsPage";
import InactivePatientsPage from "./pages/InactivePatientsPage";
import DeclinedPatientsPage from "./pages/DeclinedPatientsPage";
import Patient360Page from "./pages/Patient360Page";
import WorkspaceHome from "./pages/WorkspaceHome";
import MyWorkPage from "./pages/MyWorkPage";
import PatientFlowPage from "./pages/PatientFlowPage";
import OpportunitiesPage from "./pages/OpportunitiesPage";
import PlaybooksPage from "./pages/PlaybooksPage";
import WorklistPage from "./pages/WorklistPage";
import CallWorkflowPage from "./pages/CallWorkflowPage";
import StaffAssignmentPage from "./pages/StaffAssignmentPage";
import EscalationsPage from "./pages/EscalationsPage";
import BillingPage from "./pages/BillingPage";
import FollowUpsPage from "./pages/FollowUpsPage";
import ReportsPage from "./pages/ReportsPage";
import BulkImportPage from "./pages/BulkImportPage";
import AuditLogPage from "./pages/AuditLogPage";
import TeamAccessPage from "./pages/TeamAccessPage";
import ClinicsPage from "./pages/ClinicsPage";
import ProvidersPage from "./pages/ProvidersPage";
import RefillRequestsPage from "./pages/RefillRequestsPage";
import ReachOutPage from "./pages/ReachOutPage";
import ApcmPage from "./pages/ApcmPage";
import WorkforcePage from "./pages/WorkforcePage";
import MyDayPage from "./pages/MyDayPage";
import MySchedulePage from "./pages/MySchedulePage";
import TeamSchedulePage from "./pages/TeamSchedulePage";
import IntegrationsPage from "./pages/IntegrationsPage";
import PatientEmailsPage from "./pages/PatientEmailsPage";
import { RingCentralPhone } from "./components/phone/RingCentralPhone";
import ChangePasswordPage from "./pages/ChangePasswordPage";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/change-password" component={ChangePasswordPage} />
      <Route path="/home" component={WorkspaceHome} />
      <Route path="/my-work" component={MyWorkPage} />
      <Route path="/patient-flow" component={PatientFlowPage} />
      <Route path="/opportunities" component={OpportunitiesPage} />
      <Route path="/playbooks" component={PlaybooksPage} />
      <Route path="/playbooks/:slug" component={PlaybooksPage} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/coordinator" component={CoordinatorDashboard} />
      <Route path="/patients" component={PatientsPage} />
      <Route path="/inactive-patients" component={InactivePatientsPage} />
      <Route path="/declined-patients" component={DeclinedPatientsPage} />
      <Route path="/patients/import" component={BulkImportPage} />
      <Route path="/patients/:id" component={Patient360Page} />
      <Route path="/audit" component={AuditLogPage} />
      <Route path="/team" component={TeamAccessPage} />
      <Route path="/clinics" component={ClinicsPage} />
      <Route path="/providers" component={ProvidersPage} />
      <Route path="/worklist" component={WorklistPage} />
      <Route path="/workflow" component={CallWorkflowPage} />
      <Route path="/workflow/:taskId" component={CallWorkflowPage} />
      <Route path="/assignment" component={StaffAssignmentPage} />
      <Route path="/escalations" component={EscalationsPage} />
      <Route path="/refill-requests" component={RefillRequestsPage} />
      <Route path="/reach-out" component={ReachOutPage} />
      <Route path="/apcm" component={ApcmPage} />
      <Route path="/workforce" component={WorkforcePage} />
      <Route path="/my-day" component={MyDayPage} />
      <Route path="/my-schedule" component={MySchedulePage} />
      <Route path="/team-schedule" component={TeamSchedulePage} />
      <Route path="/integrations" component={IntegrationsPage} />
      <Route path="/patient-emails" component={PatientEmailsPage} />
      <Route path="/billing" component={BillingPage} />
      <Route path="/follow-ups" component={FollowUpsPage} />
      <Route path="/reports" component={ReportsPage} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable>
        <TooltipProvider>
          <Toaster />
          <Router />
          {/* Mounted once for the whole app so a call keeps going while you change pages. */}
          <RingCentralPhone />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
