package httpapi

import "testing"

func TestAttachmentTrustBoundary(t *testing.T) {
	if !allowedAttachmentType("application/pdf") || !allowedAttachmentType("image/png") {
		t.Fatal("expected supported document and image types")
	}
	if allowedAttachmentType("application/x-sh") {
		t.Fatal("executable content must not be accepted")
	}
	if got := safeHeaderFilename("../report\".pdf"); got != "report-.pdf" {
		t.Fatalf("unsafe filename was not normalized: %q", got)
	}
}
