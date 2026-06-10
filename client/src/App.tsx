import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import AdminDashboard from "./pages/AdminDashboard";
import StaffDashboard from "./pages/StaffDashboard";
import ProviderDashboard from "./pages/ProviderDashboard";
import BillingDashboard from "./pages/BillingDashboard";
import FrontDeskDashboard from "./pages/FrontDeskDashboard";
import MonthlyWorklist from "./pages/MonthlyWorklist";
import { useAuth } from "./_core/hooks/useAuth";
import { Loader2 } from "lucide-react";

function Router() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <Switch>
      <Route path={"/"} component={Home} />
      
      {/* Admin Routes */}
      {user && user.role === "admin" && (
        <>
          <Route path={"/admin/dashboard"} component={AdminDashboard} />
          <Route path={"/admin/worklist"} component={MonthlyWorklist} />
        </>
      )}
      
      {/* Staff Routes */}
      {user && (user.role === "staff" || user.role === "admin") && (
        <>
          <Route path={"/staff/dashboard"} component={StaffDashboard} />
          <Route path={"/staff/worklist"} component={MonthlyWorklist} />
        </>
      )}
      
      {/* Provider Routes */}
      {user && (user.role === "provider" || user.role === "admin") && (
        <Route path={"/provider/dashboard"} component={ProviderDashboard} />
      )}
      
      {/* Billing Routes */}
      {user && (user.role === "billing" || user.role === "admin") && (
        <Route path={"/billing/dashboard"} component={BillingDashboard} />
      )}
      
      {/* Front Desk Routes */}
      {user && (user.role === "front_desk" || user.role === "admin") && (
        <Route path={"/front-desk/dashboard"} component={FrontDeskDashboard} />
      )}
      
      <Route path={"/404"} component={NotFound} />
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
