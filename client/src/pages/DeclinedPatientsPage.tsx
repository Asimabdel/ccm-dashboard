import { Ban } from "lucide-react";
import { EnrollmentPatients } from "@/components/EnrollmentPatients";

export default function DeclinedPatientsPage() {
  return (
    <EnrollmentPatients
      status="declined"
      title="Declined CCM"
      note="Patients who declined CCM are kept here and off the monthly worklist."
      emptyText="No patients have declined CCM."
      reactivateLabel="Re-enroll"
      icon={Ban}
    />
  );
}
