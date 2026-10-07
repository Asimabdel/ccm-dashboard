import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, useLocation } from "wouter";
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
import MessagesPage from "./pages/MessagesPage";
import DailyReportsPage from "./pages/DailyReportsPage";
import ProviderReportPage from "./pages/ProviderReportPage";
import WellnessPage from "./pages/WellnessPage";
import InsuranceCheckerPage from "./pages/InsuranceCheckerPage";
import TeamProgressPage from "./pages/TeamProgressPage";
import FaxInboxPage from "./pages/FaxInboxPage";
import ChartPage from "./pages/ChartPage";
import WebsiteBookingsPage from "./pages/WebsiteBookingsPage";
import IntakeFormsPage from "./pages/IntakeFormsPage";
import IntakePrintPage from "./pages/IntakePrintPage";
import PatientFormsPage from "./pages/PatientFormsPage";
import DocumentsPage from "./pages/DocumentsPage";
import PaymentsPage from "./pages/PaymentsPage";
import CarePlansPage from "./pages/CarePlansPage";
import ConditionLibraryPage from "./pages/ConditionLibraryPage";
import CarePlanPrintPage from "./pages/CarePlanPrintPage";
import LearnPage from "./pages/LearnPage";
import FolderPage from "./pages/FolderPage";
import DirectoryPage from "./pages/DirectoryPage";
import ProgramApprovalsPage from "./pages/ProgramApprovalsPage";
import TestingPage from "./pages/TestingPage";
import RecordMatchingPage from "./pages/RecordMatchingPage";
import { RingCentralPhone } from "./components/phone/RingCentralPhone";
import ChangePasswordPage from "./pages/ChangePasswordPage";

// The PDF editor pulls in pdf.js, so it loads only when opened.
const DocumentEditorPage = lazy(() => import("./pages/DocumentEditorPage"));
function DocumentEditorRoute() {
  return <Suspense fallback={<div className="p-10 text-sm text-slate-500">Loading…</div>}><DocumentEditorPage /></Suspense>;
}

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
      {/* Patients = everyone at the clinics; the CCM list is the CCM roster. */}
      <Route path="/patients" component={DirectoryPage} />
      <Route path="/ccm-roster" component={PatientsPage} />
      <Route path="/program-approvals" component={ProgramApprovalsPage} />
      <Route path="/testing" component={TestingPage} />
      <Route path="/care-plans" component={CarePlansPage} />
      <Route path="/care-plans/library/:key" component={ConditionLibraryPage} />
      <Route path="/care-plans/:patientId/print" component={CarePlanPrintPage} />
      <Route path="/record-matching" component={RecordMatchingPage} />
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
      <Route path="/messages" component={MessagesPage} />
      <Route path="/daily-reports" component={DailyReportsPage} />
      <Route path="/provider-report" component={ProviderReportPage} />
      <Route path="/wellness" component={WellnessPage} />
      <Route path="/insurance" component={InsuranceCheckerPage} />
      <Route path="/team-progress" component={TeamProgressPage} />
      <Route path="/faxes" component={FaxInboxPage} />
      <Route path="/chart/:key" component={ChartPage} />
      <Route path="/bookings" component={WebsiteBookingsPage} />
      <Route path="/intake-forms/:id/print" component={IntakePrintPage} />
      <Route path="/intake-forms" component={IntakeFormsPage} />
      <Route path="/documents/:id" component={DocumentEditorRoute} />
      <Route path="/documents" component={DocumentsPage} />
      <Route path="/payments" component={PaymentsPage} />
      <Route path="/folder/:key" component={FolderPage} />
      {/* Public: the page patients open from their forms link (no MyPCP login). */}
      <Route path="/f/:token" component={PatientFormsPage} />
      {/* Public: an open form link for the website (e.g. /sign/consent). */}
      <Route path="/sign/:slug" component={PatientFormsPage} />
      {/* Public: patient education handouts (provider-approved; no login, no patient details). */}
      <Route path="/learn" component={LearnPage} />
      <Route path="/learn/print" component={LearnPage} />
      <Route path="/learn/s/:code" component={LearnPage} />
      <Route path="/learn/flyer/:slug" component={LearnPage} />
      <Route path="/learn/:slug" component={LearnPage} />
      <Route path="/billing" component={BillingPage} />
      <Route path="/follow-ups" component={FollowUpsPage} />
      <Route path="/reports" component={ReportsPage} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [loc] = useLocation();
  // Patient forms page and printouts: no staff phone, always light.
  const patientOrPrint = loc.startsWith("/f/") || loc.startsWith("/sign/") || loc === "/learn" || loc.startsWith("/learn/") || loc.endsWith("/print");
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light" switchable forceLight={patientOrPrint}>
        <TooltipProvider>
          <Toaster />
          <Router />
          {/* Mounted once for the whole app so a call keeps going while you change pages. */}
          {!patientOrPrint && <RingCentralPhone />}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
