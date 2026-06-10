import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { ArrowRight } from "lucide-react";

/**
 * Home page that redirects to appropriate dashboard based on user role
 */
export default function Home() {
  const { user, loading, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (loading) return;

    if (!isAuthenticated) {
      // User not authenticated - stay on home
      return;
    }

    // Redirect based on user role
    if (user?.role === "admin") {
      setLocation("/admin");
    } else if (user?.role === "provider") {
      setLocation("/provider");
    } else if (user?.role === "billing") {
      setLocation("/billing");
    } else if (user?.role === "front_desk") {
      setLocation("/front-desk");
    } else if (user?.role === "staff") {
      setLocation("/staff");
    } else {
      // Default to staff dashboard
      setLocation("/staff");
    }
  }, [user, loading, isAuthenticated, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Spinner className="w-8 h-8 mx-auto mb-4" />
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
        <div className="text-center max-w-md px-6">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            CCM Operations Dashboard
          </h1>
          <p className="text-gray-600 mb-2">
            A comprehensive Chronic Care Management platform for streamlined patient outreach, documentation, and provider coordination.
          </p>
          <p className="text-sm text-gray-500 mb-8">
            Manage your CCM program efficiently with real-time analytics, automated workflows, and role-based dashboards.
          </p>
          
          <a href={getLoginUrl()}>
            <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg flex items-center justify-center gap-2 transition-all duration-200">
              Log In to Dashboard
              <ArrowRight className="w-5 h-5" />
            </Button>
          </a>

          <p className="text-xs text-gray-500 mt-6">
            Powered by Manus • Secure OAuth Authentication
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <Spinner className="w-8 h-8 mx-auto mb-4" />
        <p className="text-gray-600">Redirecting to your dashboard...</p>
      </div>
    </div>
  );
}
