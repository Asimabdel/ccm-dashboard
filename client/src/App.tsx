import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import AdminDashboard from "./pages/AdminDashboard";
import PatientsPage from "./pages/PatientsPage";
import PatientDetailPage from "./pages/PatientDetailPage";
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

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/admin" component={AdminDashboard} />
      <Route path="/patients" component={PatientsPage} />
      <Route path="/patients/import" component={BulkImportPage} />
      <Route path="/patients/:id" component={PatientDetailPage} />
      <Route path="/audit" component={AuditLogPage} />
      <Route path="/team" component={TeamAccessPage} />
      <Route path="/clinics" component={ClinicsPage} />
      <Route path="/providers" component={ProvidersPage} />
      <Route path="/worklist" component={WorklistPage} />
      <Route path="/workflow" component={CallWorkflowPage} />
      <Route path="/workflow/:taskId" component={CallWorkflowPage} />
      <Route path="/assignment" component={StaffAssignmentPage} />
      <Route path="/escalations" component={EscalationsPage} />
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
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
