package handlers

import "testing"

func TestParseID(t *testing.T) {
	tests := []struct {
		in      string
		want    int64
		wantErr bool
	}{
		{"42", 42, false},
		{"0", 0, true},
		{"-1", 0, true},
		{"abc", 0, true},
	}

	for _, tt := range tests {
		got, err := ParseID(tt.in)
		if (err != nil) != tt.wantErr {
			t.Fatalf("ParseID(%q) error = %v, wantErr %v", tt.in, err, tt.wantErr)
		}
		if got != tt.want {
			t.Errorf("ParseID(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}
