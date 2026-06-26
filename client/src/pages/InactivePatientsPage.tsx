import { UserMinus } from "lucide-react";
import { EnrollmentPatients } from "@/components/EnrollmentPatients";

export default function InactivePatientsPage() {
  return (
    <EnrollmentPatients
      status="inactive"
      title="Inactive Patients"
      note="Patients marked Inactive are kept here and off the monthly worklist."
      emptyText="No inactive patients."
      reactivateLabel="Reactivate"
      icon={UserMinus}
    />
  );
}
